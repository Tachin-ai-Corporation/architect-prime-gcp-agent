#!/usr/bin/env node
// responsibility-manage — author an agent's own responsibilities.
//
// Writes the agent's responsibility store (Firestore, next to its Core Memory), which
// the scheduler re-reads every minute: a change is live without a Fleet release and
// without a CoreKit upgrade, and it survives both. It never edits an installed file —
// that was the old behaviour, and the next upgrade silently reinstalled the file
// over every change an agent had made (C-36).
//
// Who uses it:
//   * a fleet agent, for itself (the only store it may write);
//   * Prime, for itself, or for any agent under it with --agent <id> — improving a
//     fleet agent's duties is part of Prime's job (C-29). Role-wide changes still go
//     through `fleet-config` releases;
//   * the dashboard toggle goes through the same planner (agent-introspect).
//
// The rules — layering, validation, what may be overridden — live in
// platform/work/responsibility-store.mjs, shared with the scheduler, so what this
// tool accepts is exactly what the scheduler will run.
//
// Usage: responsibility-manage [--agent <id>] [--note "<why>"] [--json] <verb> ...
//   list                                   what this agent runs, and where each definition comes from
//   show <id>                              one responsibility, as it runs
//   create '<json>' | --stdin | --file <path>        a new responsibility of the agent's own
//   update <id> '<json>' | --stdin | --file <path>   change fields (a shipped default gets an override)
//   toggle <id> [on|off]                   enable / disable
//   remove <id>                            delete one the agent created
//   reset <id>                             drop the agent's changes to a shipped default
//   adopt <id> ['<json>']                  take a shipped default over completely (stops tracking it)
//   history <id>                           every revision, newest first
//   revert <id> --to <revision>            restore an earlier revision (as a new revision)
// create/update also take --process-ref <id> and --process-params '<json>' ("" clears on update).

import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { createClient, StoreConflict, StoreUnavailable } from '../../platform/persistence/firestore.mjs';
import { cronNextFire } from '../../platform/work/scheduler.mjs';
import {
  STORE_COLLECTION, REVISIONS_COLLECTION, storeParent, resolvePolicy, loadShipped,
  mergeResponsibilities, planWrite, describeProvenance,
} from '../../platform/work/responsibility-store.mjs';

const CORE_DIR = process.env.CORE_DIR || '/opt/corekit';
const LIVE_NOTE = 'Live within a minute — no release or upgrade needed.';

function die(msg, code = 1) {
  process.stderr.write(`responsibility-manage: ${msg}\n`);
  process.exit(code);
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}

async function metadata(path) {
  try {
    const r = await fetch(`http://metadata.google.internal/computeMetadata/v1/${path}`, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(2000),
    });
    return r.ok ? (await r.text()).trim() : '';
  } catch {
    return '';
  }
}

/**
 * Who is running this, and where their store is. The agent id comes from the service
 * environment, then instance metadata, then the fleet-<id> hostname — an SSH shell
 * has no AGENT_ID, and falling back to the Prime scope there is exactly how Core
 * Memory writes once landed in a store the agent never read.
 */
async function identity() {
  const isPrime = existsSync(`${CORE_DIR}/corekit/prime-config.json`);
  const chat = readJson(`${CORE_DIR}/corekit/chat-config.json`);
  const prime = readJson(`${CORE_DIR}/corekit/prime-config.json`);
  const projectId = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT
    || prime.projectId || chat.projectId || await metadata('project/project-id');
  const primeId = process.env.PRIME_ID || prime.primeId || chat.primeId
    || await metadata('instance/attributes/prime_id') || hostname().replace(/^prime-/, '');
  let agentId = null;
  if (!isPrime) {
    const env = process.env.AGENT_ID;
    agentId = (env && env !== 'agent' && env !== 'prime') ? env
      : (await metadata('instance/attributes/agent_id')) || (hostname().startsWith('fleet-') ? hostname().slice(6) : '');
  }
  if (!projectId) die('cannot determine the GCP project');
  if (!primeId) die('cannot determine the prime id');
  if (!isPrime && !agentId) die('cannot determine this agent\'s id (AGENT_ID, instance metadata agent_id, or a fleet-<id> hostname)');
  return { isPrime, projectId, primeId, agentId };
}

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  const valued = new Set(['--agent', '--note', '--file', '--to', '--process-ref', '--process-params']);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (valued.has(a)) {
      if (i + 1 >= argv.length) die(`${a} needs a value`);
      flags[a.slice(2)] = argv[i += 1];
    } else if (a === '--stdin' || a === '--json' || a === '--help' || a === '-h') {
      flags[a.replace(/^-+/, '')] = true;
    } else if (a.startsWith('--')) {
      die(`unknown option ${a}`);
    } else {
      pos.push(a);
    }
  }
  return { flags, pos };
}

function readBody(flags, positional, { required = true } = {}) {
  let raw = null;
  if (flags.stdin) raw = readFileSync(0, 'utf8');
  else if (flags.file) raw = readFileSync(flags.file, 'utf8');
  else if (positional !== undefined) raw = existsSync(positional) ? readFileSync(positional, 'utf8') : positional;
  let body = {};
  if (raw !== null && String(raw).trim()) {
    try {
      body = JSON.parse(raw);
    } catch (e) {
      die(`the body is not valid JSON (${e.message}). Free text with quotes or apostrophes is safest on --stdin.`);
    }
  } else if (required && flags['process-ref'] === undefined && flags['process-params'] === undefined) {
    die('a JSON body is required (inline, --stdin, or --file <path>)');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) die('the body must be one JSON object');
  if (flags['process-ref'] !== undefined) body.processRef = flags['process-ref'] || null;
  if (flags['process-params'] !== undefined) {
    if (!flags['process-params']) body.processParameters = null;
    else {
      try { body.processParameters = JSON.parse(flags['process-params']); } catch (e) { die(`--process-params must be JSON: ${e.message}`); }
    }
  }
  return body;
}

const usage = () => `Usage: responsibility-manage [--agent <id>] [--note "<why>"] [--json] <verb> ...
  list | show <id> | create <json> | update <id> <json> | toggle <id> [on|off]
  remove <id> | reset <id> | adopt <id> [<json>] | history <id> | revert <id> --to <revision>
A body may be inline JSON, --stdin, or --file <path>. create needs id, name, schedule
(five-field cron) or event, instruction, success_criteria, context.purpose and
context.process; timezone is an IANA zone (default UTC). Changes go to the agent's
own store and are live within a minute. See skills/work-management/SKILL.md.`;

function scheduleOf(r) {
  if (r.schedule) return `${r.schedule} ${r.timezone || 'UTC'}`;
  if (r.event) return `on ${r.event}`;
  return '(no trigger)';
}

async function main() {
  const { flags, pos } = parseArgs(process.argv.slice(2));
  const verb = pos[0];
  if (!verb || flags.help || flags.h || verb === 'help') { process.stdout.write(`${usage()}\n`); return; }

  const me = await identity();
  let target;
  if (flags.agent && flags.agent !== me.agentId) {
    // "Their own": a fleet agent writes only its own store. Prime writes any agent
    // under it — improving fleet agents is part of its job — and records itself as
    // the author.
    if (!me.isPrime) die('a fleet agent manages only its own responsibilities; Prime edits other agents');
    target = { parent: storeParent({ primeId: me.primeId, agentId: flags.agent, isPrime: false }), label: flags.agent, local: false, agentId: flags.agent };
  } else {
    target = { parent: storeParent(me), label: me.isPrime ? `prime ${me.primeId}` : me.agentId, local: true, agentId: me.agentId };
  }
  const actor = me.isPrime ? `prime:${me.primeId}` : me.agentId;
  const policy = resolvePolicy(readJson(`${CORE_DIR}/corekit/contracts.json`));
  const db = createClient({ projectId: me.projectId, logger: (level, ...m) => { if (level !== 'DEBUG') process.stderr.write(`[firestore] ${level} ${m.join(' ')}\n`); } });

  const shipped = target.local ? loadShipped(CORE_DIR) : [];
  const shippedById = new Map(shipped.map((r) => [r.id, r]));
  const docPath = (id) => `${target.parent}/${STORE_COLLECTION}/${id}`;
  const listStore = () => db.query(target.parent, STORE_COLLECTION, [], { noOrderBy: true, strict: true, limit: 200 });
  const merge = (docs) => mergeResponsibilities(shipped, docs, { policy, nextFire: cronNextFire });

  const out = (human, data) => {
    if (flags.json) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    else process.stdout.write(`${human}\n`);
  };

  async function write(id, planArgs) {
    const current = await db.readDoc(docPath(id));
    const docs = await listStore();
    const ownCount = docs.filter((d) => d.mode === 'own' && d.status !== 'removed' && d.id !== id).length;
    const plan = planWrite({
      id, actor, note: flags.note || '', policy, nextFire: cronNextFire, ownCount,
      current: current?.data || null,
      shipped: shippedById.get(id) || null,
      shippedKnown: target.local,
      ...planArgs,
    });
    if (!plan.ok) die(plan.error);
    const doc = { ...plan.doc, prime_id: me.primeId, agent_id: target.agentId || null };
    await db.commit([
      { path: docPath(id), data: doc, precondition: current ? { updateTime: current.updateTime } : { exists: false } },
      { path: `${docPath(id)}/${REVISIONS_COLLECTION}/${doc.revision}`, data: doc, precondition: { exists: false } },
    ]);
    const where = target.local ? '' : ` for ${target.label}`;
    out(`${plan.summary[0].toUpperCase()}${plan.summary.slice(1)}${where} — revision ${doc.revision}. ${LIVE_NOTE}`, { ok: true, id, revision: doc.revision, doc });
  }

  switch (verb) {
    case 'list': {
      const docs = await listStore();
      if (!target.local) {
        const rows = docs.map((d) => `  ${d.id.padEnd(34)} ${d.mode.padEnd(8)} ${d.status.padEnd(7)} rev ${d.revision} by ${d.updated_by}`
          + (d.mode === 'override' ? `  sets: ${Object.keys(d.patch || {}).join(', ')}` : `  ${scheduleOf(d.body || {})}`));
        out(`Store records for ${target.label} (overrides + its own; its shipped defaults live on the agent — the dashboard shows the full set):\n${rows.join('\n') || '  (none)'}`, { agent: target.label, records: docs });
        return;
      }
      const { effective, issues } = merge(docs);
      const rows = effective.map((r) => `  ${r.id.padEnd(34)} ${scheduleOf(r).padEnd(30)} ${r.enabled ? 'enabled ' : 'DISABLED'} ${describeProvenance(r)}`);
      const warn = issues.map((i) => `  ! ${i.id}: ${i.reason}`);
      out(`Responsibilities for ${target.label}:\n${rows.join('\n') || '  (none)'}${warn.length ? `\nIgnored store records:\n${warn.join('\n')}` : ''}\nTotal: ${effective.length}`,
        { agent: target.label, responsibilities: effective, issues });
      return;
    }

    case 'show': {
      const id = pos[1] || die('show needs an id');
      const docs = await listStore();
      const record = target.local ? merge(docs).effective.find((r) => r.id === id) : null;
      const doc = docs.find((d) => d.id === id) || null;
      if (!record && !doc) die(`'${id}' not found for ${target.label}`);
      out(JSON.stringify({ effective: record || '(shipped default not visible from here)', store: doc }, null, 2), { effective: record, store: doc });
      return;
    }

    case 'create': {
      const body = readBody(flags, pos[1]);
      if (!body.id) die('the body needs an id (lowercase letters, digits, dashes)');
      return write(body.id, { verb: 'create', input: body });
    }

    case 'update': {
      const id = pos[1] || die('update needs an id');
      return write(id, { verb: 'update', input: readBody(flags, pos[2]) });
    }

    case 'toggle': {
      const id = pos[1] || die('toggle needs an id');
      let want = pos[2];
      if (want && want !== 'on' && want !== 'off') die('toggle takes on or off');
      if (!want) {
        const docs = await listStore();
        const now = target.local ? merge(docs).effective.find((r) => r.id === id) : null;
        const doc = docs.find((d) => d.id === id && d.status !== 'removed');
        const enabled = now ? now.enabled : (doc?.mode === 'own' ? doc.body?.enabled : doc?.patch?.enabled);
        if (enabled === undefined) die(`cannot tell whether '${id}' is on from here — say toggle ${id} on|off`);
        want = enabled ? 'off' : 'on';
      }
      return write(id, { verb: 'update', input: { enabled: want === 'on' } });
    }

    case 'remove': return write(pos[1] || die('remove needs an id'), { verb: 'remove' });
    case 'reset': return write(pos[1] || die('reset needs an id'), { verb: 'reset' });

    case 'adopt': {
      const id = pos[1] || die('adopt needs an id');
      const changes = (pos[2] !== undefined || flags.stdin || flags.file) ? readBody(flags, pos[2]) : {};
      return write(id, { verb: 'adopt', input: changes });
    }

    case 'history': {
      const id = pos[1] || die('history needs an id');
      const revs = (await db.query(docPath(id), REVISIONS_COLLECTION, [], { noOrderBy: true, strict: true, limit: 200 }))
        .sort((a, b) => b.revision - a.revision);
      if (!revs.length) die(`'${id}' has no history in ${target.label}'s store`);
      const rows = revs.map((d) => `  rev ${String(d.revision).padEnd(4)} ${d.updated_at}  ${String(d.updated_by).padEnd(18)} ${d.mode}/${d.status}`
        + (d.mode === 'override' ? `  sets ${Object.keys(d.patch || {}).join(', ')}` : `  ${scheduleOf(d.body || {})}`)
        + (d.note ? `  — ${d.note}` : '') + (d.reverted_from ? `  (restores rev ${d.reverted_from})` : ''));
      out(`History of ${id} for ${target.label}:\n${rows.join('\n')}`, { id, revisions: revs });
      return;
    }

    case 'revert': {
      const id = pos[1] || die('revert needs an id');
      const to = Number(flags.to);
      if (!Number.isInteger(to) || to < 1) die('revert needs --to <revision number>');
      const rev = await db.read(`${docPath(id)}/${REVISIONS_COLLECTION}/${to}`, { strict: true });
      return write(id, { verb: 'revert', revisionDoc: rev });
    }

    default:
      die(`unknown verb '${verb}'\n${usage()}`);
  }
}

main().catch((e) => {
  if (e instanceof StoreConflict) die(`${e.message}\nSomeone changed it at the same moment — run the command again.`, 3);
  if (e instanceof StoreUnavailable) die(`the responsibility store is unreachable: ${e.message}`, 2);
  die(e?.stack || String(e));
});
