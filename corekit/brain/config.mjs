// corekit/brain/config.mjs — Configuration Loader
//
// Reads brain config from contracts.json and per-agent config from the
// agent directories. Each agent has a workspace directory containing
// SOUL.md (system prompt) and optionally config.json (model, tools, params).

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { withPosture } from '../../platform/contracts/posture.mjs';

const CORE_DIR = process.env.CORE_DIR || '/opt/corekit';
const CONTRACTS_PATH = process.env.CONTRACTS_PATH || join(CORE_DIR, 'corekit/contracts.json');
const AGENTS_DIR = process.env.AGENTS_DIR || join(CORE_DIR, 'agents/main/agent');
const WORKSPACE_BASE = process.env.WORKSPACE_BASE || CORE_DIR;

let _contracts = null;

/**
 * Load contracts.json (cached).
 */
export function getContracts() {
  if (!_contracts) {
    try {
      _contracts = JSON.parse(readFileSync(CONTRACTS_PATH, 'utf8'));
      // Capability posture (C-37): overlay by role so model selection (vertex.strong_model_agents)
      // and the gateway tool-call budget (brain.max_iterations) reflect the prime 'unbound' /
      // fleet 'strict' posture. The gateway is role-blind by env, so it reads the same
      // prime-config.json disk marker the daemon launcher branches on. Widens cognition only.
      _contracts = withPosture(_contracts, { isPrime: existsSync(join(CORE_DIR, 'corekit/prime-config.json')) });
    } catch (err) {
      console.warn(`[config] Failed to load contracts: ${err.message}`);
      _contracts = {};
    }
  }
  return _contracts;
}

/**
 * Load an agent's configuration.
 *
 * Reads:
 *   - {workspace}/SOUL.md → system prompt
 *   - contracts.json → default model, fallback, location
 *   - {workspace}/config.json → agent-specific overrides (if present)
 *
 * @param {string} agentId  e.g. "cortex", "motor", "prefrontal"
 * @returns {object} { model, fallbackModel, systemPrompt, maxSteps, workspace, allowedTools }
 */
export function loadAgentConfig(agentId, opts = {}) {
  const contracts = getContracts();
  const workspace = agentId === 'cortex'
    ? join(WORKSPACE_BASE, 'workspace')
    : join(WORKSPACE_BASE, `workspace-${agentId}`);

  // System prompt from SOUL.md in agent workspace
  let systemPrompt = '';
  const soulPath = join(workspace, 'SOUL.md');
  if (existsSync(soulPath)) {
    systemPrompt = readFileSync(soulPath, 'utf8');
  }

  // Default model from contracts. Phase E (CR-9): a subagent may run on the stronger
  // `subagentStrong` (gemini-2.5-pro) instead of `subagent` (flash) when opts.strong is set
  // — the gateway sets it for the planning/execution organs (prefrontal, motor) that churned
  // on a real code+deploy mission. Cortex is unaffected (always its own model).
  const vertexCfg = contracts.vertex || {};
  const models = vertexCfg.models || {};
  const defaultModel = agentId === 'cortex'
    ? (models.cortex || 'vertex-google/gemini-3.6-flash')
    : (models.subagent || 'vertex-google/gemini-3.6-flash');
  const fallbackModel = models.cortexFallback || 'vertex-google/gemini-3.6-flash';
  // Phase E (CR-9): a strong-tier request routes a subagent to `subagentStrong`
  // (gemini-2.5-pro). It must win over BOTH the contracts default AND any per-agent
  // workspace config.json `model` pin — workspace-motor/-prefrontal pin flash, and that
  // pin (applied via agentOverrides.model in the return) would otherwise silently defeat
  // the strong routing, which is exactly what happened on first deploy.
  const strongModel = (opts.strong && agentId !== 'cortex' && models.subagentStrong)
    ? models.subagentStrong
    : null;

  const brainCfg = contracts.brain || {};
  const maxSteps = brainCfg.max_iterations || 12;

  // Agent-specific config overrides
  let agentOverrides = {};
  const configPath = join(workspace, 'config.json');
  if (existsSync(configPath)) {
    try {
      agentOverrides = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {}
  }

  // Execution agents (motor, cerebellum, temporal-research) always get tools.
  // Planning/synthesizing agents (cortex, prefrontal) never do.
  // Temporal-Memory is the memory authority (TEMPORAL_MEMORY_AUTHORITY_PLAN): toolless on
  // the RECALL hot path (the daemon pre-fetches, C-5), but tool-capable when dispatched to
  // EXECUTE (consolidation) — signaled per-request by opts.exec. Fail-safe: without the
  // signal it stays toolless, so recall is never accidentally tool-enabled.
  const EXECUTION_AGENTS = new Set(['motor', 'cerebellum', 'temporal-research']);
  const TOOL_ON_REQUEST = new Set(['temporal-memory']);
  const needsTools = EXECUTION_AGENTS.has(agentId) || (opts.exec === true && TOOL_ON_REQUEST.has(agentId));

  return {
    model: strongModel || agentOverrides.model || defaultModel,
    fallbackModel: agentOverrides.fallbackModel || fallbackModel,
    systemPrompt,
    maxSteps: needsTools ? (agentOverrides.maxSteps || maxSteps) : 1,
    workspace,
    allowedTools: agentId === 'cerebellum'
      ? ['readFile', 'report_pass', 'report_fail', 'request_probe']
      : needsTools ? (agentOverrides.allowedTools || null) : [],
  };
}

/**
 * Get the neural gateway config.
 */
export function getBrainConfig() {
  const contracts = getContracts();
  return {
    port: parseInt(process.env.BRAIN_PORT || contracts.gateway?.port || '18789', 10),
    project: process.env.GOOGLE_CLOUD_PROJECT || contracts.vertex?.project || '',
    googleLocation: process.env.GOOGLE_LOCATION || contracts.vertex?.location || 'global',
    anthropicLocation: process.env.ANTHROPIC_LOCATION || contracts.vertex?.anthropicLocation || 'us-east5',
  };
}
