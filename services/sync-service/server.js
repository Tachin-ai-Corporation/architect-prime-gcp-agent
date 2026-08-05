// server.js — Sync service orchestrator
//
// Three sync tiers:
//   1. Webhook (instant)    — Changes API push notification → smart sync
//   2. Smart poll (10s)     — list folder, compare modifiedTime, sync delta
//   3. Reconciliation (5m)  — full sync + GCS deletion reconciliation
//   4. Cloud Scheduler (15m)— external POST /sync-all safety net
//
// Hardening:
//   - try/catch inside setInterval prevents silent poll loop death
//   - Watchdog timer: process.exit(1) after 5 minutes stale
//   - /health returns 503 when stale → Cloud Run liveness restarts container
//   - process.on('unhandledRejection') catches + logs
//   - syncRunning mutex prevents overlapping syncs

const express = require('express');
const { syncService, smartSync, fullSync, getDrive, getFileCache } = require('./index');
const { initChangesWatch, recordWebhook, getWatchStatus, registerWatch } = require('./watchHandler');

const app = express();
app.use(express.json());

// ── Configuration ───────────────────────────────────────────────────────────

const POLL_INTERVAL_MS     = 10_000;    // 10 seconds — smart delta check
const RECONCILE_INTERVAL_MS = 300_000;  // 5 minutes  — full reconciliation
const WATCHDOG_INTERVAL_MS  = 60_000;   // 1 minute   — check if poll is alive
const WATCHDOG_MAX_STALE_MS = 300_000;  // 5 minutes  — stale threshold

// ── State ───────────────────────────────────────────────────────────────────

let lastSuccessfulPoll = Date.now();
let lastSmartSyncTime = null;
let lastFullSyncTime = null;
let consecutiveFailures = 0;
let syncRunning = false;
let startupComplete = false;

const stats = {
  smartSyncs: 0,
  fullSyncs: 0,
  webhookSyncs: 0,
  filesChanged: 0,
  filesDeleted: 0,
  noopPolls: 0
};

// ── Sync orchestration ──────────────────────────────────────────────────────

async function doSmartSync(source) {
  if (syncRunning) return null;
  syncRunning = true;
  try {
    const result = await smartSync();
    lastSmartSyncTime = Date.now();
    stats.smartSyncs++;
    stats.filesChanged += result.synced.length;
    stats.filesDeleted += result.deleted.length;

    if (result.synced.length || result.deleted.length) {
      console.log(`Smart sync (${source}): ${result.synced.length} synced, ${result.deleted.length} deleted, ${result.unchanged} unchanged`);
    } else {
      stats.noopPolls++;
    }
    return result;
  } finally {
    syncRunning = false;
  }
}

async function doFullSync(source) {
  if (syncRunning) return null;
  syncRunning = true;
  try {
    console.log(`Full sync triggered (source: ${source})...`);
    const result = await fullSync();
    lastFullSyncTime = Date.now();
    lastSmartSyncTime = Date.now();
    stats.fullSyncs++;
    stats.filesChanged += result.syncedFiles.length;
    stats.filesDeleted += result.deletedFiles.length;
    console.log(`Full sync (${source}): ${result.syncedFiles.length} synced, ${result.deletedFiles.length} deleted`);
    return result;
  } finally {
    syncRunning = false;
  }
}

// ── Routes ──────────────────────────────────────────────────────────────────

// Legacy single-file sync
app.post('/', syncService);
app.post('/syncService', syncService);

// Full sync — Cloud Scheduler, manual trigger, legacy
app.post('/sync-all', async (req, res) => {
  const resourceState = req.headers['x-goog-resource-state'];
  if (resourceState === 'sync') {
    return res.status(200).send('OK');
  }

  try {
    const result = await doFullSync('api');
    if (!result) return res.status(202).json({ message: 'Sync already running' });
    res.status(200).json({ message: 'Sync-all completed', ...result });
  } catch (err) {
    console.error('Error in /sync-all:', err);
    res.status(500).json({ error: err.message });
  }
});

// Changes API webhook — instant push notification
app.post('/webhook/changes', async (req, res) => {
  // Acknowledge immediately — Google expects fast response
  res.status(200).send('OK');

  const resourceState = req.headers['x-goog-resource-state'];
  const channelId = req.headers['x-goog-channel-id'];
  recordWebhook();

  if (resourceState === 'sync') {
    console.log(`[webhook] Sync handshake acknowledged (channel=${channelId})`);
    return;
  }

  console.log(`[webhook] Change notification received (state=${resourceState}, channel=${channelId})`);

  try {
    const result = await doSmartSync('webhook');
    if (result) stats.webhookSyncs++;
  } catch (err) {
    console.error('[webhook] Smart sync failed:', err.message);
  }
});

// Watch management
app.post('/renew-watch', registerWatch);

// Pub/Sub push handler
app.post('/pubsub/drive-event', async (req, res) => {
  console.log('Received Pub/Sub push event');
  res.status(204).send();
  try { await doSmartSync('pubsub'); } catch (err) {
    console.error('Pub/Sub sync failed:', err.message);
  }
});

// Health check — returns 503 when poll loop is stale
app.get('/health', (req, res) => {
  const staleSec = Math.floor((Date.now() - lastSuccessfulPoll) / 1000);
  const healthy = staleSec <= WATCHDOG_MAX_STALE_MS / 1000;
  const cache = getFileCache();
  const watch = getWatchStatus();

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'OK' : 'UNHEALTHY',
    startupComplete,
    pollIntervalMs: POLL_INTERVAL_MS,
    lastPollTime: new Date(lastSuccessfulPoll).toISOString(),
    lastSmartSyncTime: lastSmartSyncTime ? new Date(lastSmartSyncTime).toISOString() : null,
    lastFullSyncTime: lastFullSyncTime ? new Date(lastFullSyncTime).toISOString() : null,
    staleSec,
    consecutiveFailures,
    trackedFiles: cache.size,
    stats,
    watch
  });
});

// ── Startup sequence ────────────────────────────────────────────────────────

(async () => {
  const drive = getDrive();

  // 1. Register Changes API watch (replaces broken files.watch)
  try {
    await initChangesWatch(drive);
  } catch (err) {
    console.error('Changes watch init failed:', err.message);
    // Non-fatal — poll loop is the primary mechanism
  }

  // 2. Initial full sync (populates file cache for smart sync)
  try {
    console.log('Running startup full sync...');
    await doFullSync('startup');
  } catch (err) {
    console.error('Startup full sync failed:', err.message);
  }

  startupComplete = true;
  lastSuccessfulPoll = Date.now();
  console.log('Startup complete. Smart polling active.');
})();

// ── Smart poll loop (every 10 seconds) ──────────────────────────────────────

setInterval(async () => {
  if (!startupComplete) return;
  try {
    await doSmartSync('poll');
    lastSuccessfulPoll = Date.now();
    consecutiveFailures = 0;
  } catch (err) {
    consecutiveFailures++;
    console.error(`[poll] Error (failure #${consecutiveFailures}):`, err.message);
    // Swallow — keep the interval alive. Watchdog handles prolonged failure.
  }
}, POLL_INTERVAL_MS);

// ── Full reconciliation (every 5 minutes) ───────────────────────────────────

setInterval(async () => {
  if (!startupComplete) return;
  try {
    await doFullSync('reconciliation');
    lastSuccessfulPoll = Date.now();
    consecutiveFailures = 0;
  } catch (err) {
    console.error('[reconciliation] Error:', err.message);
  }
}, RECONCILE_INTERVAL_MS);

// ── Watchdog: kill process if poll loop is dead ─────────────────────────────

setInterval(() => {
  if (!startupComplete) return;
  const staleSec = Math.floor((Date.now() - lastSuccessfulPoll) / 1000);
  if (staleSec > WATCHDOG_MAX_STALE_MS / 1000) {
    console.error(`[watchdog] Poll loop stale for ${staleSec}s — exiting for Cloud Run restart`);
    process.exit(1);
  }
}, WATCHDOG_INTERVAL_MS);

// ── Safety nets ─────────────────────────────────────────────────────────────

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  // Don't exit — let poll loop and watchdog handle recovery
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  // Exit on uncaught — let Cloud Run restart
  process.exit(1);
});

// ── Start server ────────────────────────────────────────────────────────────

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
  console.log(`Smart poll: ${POLL_INTERVAL_MS / 1000}s | Reconciliation: ${RECONCILE_INTERVAL_MS / 60000}min | Watchdog: ${WATCHDOG_MAX_STALE_MS / 60000}min`);
  lastSuccessfulPoll = Date.now();
});
