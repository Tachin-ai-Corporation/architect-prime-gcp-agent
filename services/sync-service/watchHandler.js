// watchHandler.js — Changes API watch management
//
// Replaces the broken files.watch() approach with changes.watch().
// files.watch() only monitors folder METADATA changes (renames, moves).
// changes.watch() monitors ALL file changes the service account can see,
// including files added/modified/deleted inside watched folders.

const crypto = require('crypto');

const SERVICE_URL = process.env.SERVICE_URL || 'https://your-sync-service.run.app';

// ── Watch state ─────────────────────────────────────────────────────────────

let savedPageToken = null;
let watchChannelId = null;
let watchResourceId = null;
let watchExpiration = null;
let registeredAt = null;
let lastWebhookTime = null;
let renewalTimer = null;

// ── Initialize: get start token + register watch ────────────────────────────

async function initChangesWatch(drive) {
  // 1. Get initial page token
  try {
    const res = await drive.changes.getStartPageToken({ supportsAllDrives: true });
    savedPageToken = res.data.startPageToken;
    console.log(`Changes API: startPageToken = ${savedPageToken}`);
  } catch (err) {
    console.error('Failed to get startPageToken:', err.message);
    return;
  }

  // 2. Register watch channel
  await registerChannel(drive);

  // 3. Auto-renewal every 12 hours (watches expire at 24h)
  if (renewalTimer) clearInterval(renewalTimer);
  renewalTimer = setInterval(() => {
    console.log('[watch] Auto-renewing changes watch channel...');
    registerChannel(drive).catch(err => {
      console.error('[watch] Renewal failed:', err.message);
    });
  }, 12 * 60 * 60 * 1000);
}

// ── Register a changes.watch channel ────────────────────────────────────────

async function registerChannel(drive) {
  const channelId = crypto.randomUUID();
  const expiration = Date.now() + 24 * 60 * 60 * 1000;
  const address = `${SERVICE_URL}/webhook/changes`;

  console.log(`[watch] Registering changes.watch: channel=${channelId}`);
  console.log(`[watch] Webhook address: ${address}`);

  try {
    // Stop any existing channel first
    if (watchChannelId && watchResourceId) {
      try {
        await drive.channels.stop({
          requestBody: { id: watchChannelId, resourceId: watchResourceId }
        });
        console.log(`[watch] Stopped previous channel: ${watchChannelId}`);
      } catch (_) { /* channel may already be expired */ }
    }

    const res = await drive.changes.watch({
      pageToken: savedPageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      requestBody: {
        id: channelId,
        type: 'web_hook',
        address,
        expiration: String(expiration)
      }
    });

    watchChannelId = res.data.id;
    watchResourceId = res.data.resourceId;
    watchExpiration = Number(res.data.expiration);
    registeredAt = Date.now();

    console.log(`[watch] Registered: channel=${watchChannelId}, expires=${new Date(watchExpiration).toISOString()}`);
    return res.data;
  } catch (err) {
    console.error('[watch] Registration failed:', err.message);
    if (err.code === 410 || err.status === 410) {
      // Page token expired — get a fresh one
      console.log('[watch] PageToken expired (410), refreshing...');
      try {
        const tokenRes = await drive.changes.getStartPageToken({ supportsAllDrives: true });
        savedPageToken = tokenRes.data.startPageToken;
        console.log(`[watch] New startPageToken = ${savedPageToken}`);
        // Retry registration with fresh token
        return registerChannel(drive);
      } catch (refreshErr) {
        console.error('[watch] Token refresh failed:', refreshErr.message);
      }
    }
    throw err;
  }
}

// ── Record that a webhook was received ──────────────────────────────────────

function recordWebhook() {
  lastWebhookTime = Date.now();
}

// ── Status for health endpoint ──────────────────────────────────────────────

function getWatchStatus() {
  return {
    channelId: watchChannelId,
    registeredAt: registeredAt ? new Date(registeredAt).toISOString() : null,
    expiration: watchExpiration ? new Date(watchExpiration).toISOString() : null,
    expiresInMin: watchExpiration ? Math.max(0, Math.floor((watchExpiration - Date.now()) / 60000)) : null,
    lastWebhookTime: lastWebhookTime ? new Date(lastWebhookTime).toISOString() : null,
    pageToken: savedPageToken
  };
}

// ── Legacy /renew-watch handler (re-registers using new Changes API) ────────

async function registerWatch(req, res) {
  try {
    const { getDrive } = require('./index');
    await initChangesWatch(getDrive());
    res.status(200).json(getWatchStatus());
  } catch (error) {
    console.error('[watch] Manual renewal failed:', error.message);
    res.status(500).json({ error: error.message });
  }
}

module.exports = { initChangesWatch, recordWebhook, getWatchStatus, registerWatch };
