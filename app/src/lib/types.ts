// lib/types.ts — Shared TypeScript interfaces for the dashboard
// Original module
// Used by dashboard components and API routes

/* ---- Prime & Fleet types ---- */

export interface PrimeInstance {
  id: string;
  name: string;
  status: "online" | "offline" | "deploying" | "tearing_down" | "removed" | "error";
  zone: string;
  fleetCount: number;
  coreRef?: string;
}

export interface ChatMessage {
  id: string;
  sender: "admin" | "prime";
  text: string;
  timestamp: string;
}

export interface FleetAgent {
  name: string;
  status: "online" | "offline" | "deploying" | "needs_action" | "tearing_down" | "removed" | "error";
  specialty: string;
  email: string;
  coreRef?: string;
  deploySteps?: DeployStep[];
  actionRequired?: ActionRequired | null;
}

export interface DeployStep {
  id: string;
  label: string;
  status: "done" | "active" | "pending" | "failed" | "skipped";
  timestamp: string;
  detail?: string;
}

export interface ActionRequired {
  type: string;
  title: string;
  instructions: string[];
}

export interface GatewayHealth {
  status: string;
  lastCheck: string | null;
  latencyMs: number;
  consecutiveFailures: number;
  httpCode: string;
  lastRecoveryAttempt: string | null;
  lastRecoveryResult: string | null;
}

export interface AgentDetail {
  agent: string;
  status: string;
  specialty: string;
  email: string;
  vm: string;
  zone: string;
  deployedAt: string | null;
  lastHeartbeat: string | null;
  uptimeMinutes: number | null;
  healthy: boolean;
  activity: { id: string; type: string; summary: string; timestamp: string; sender: string }[];
  deploySteps?: DeployStep[];
  actionRequired?: ActionRequired | null;
  health?: GatewayHealth | null;
}

export interface SetupState {
  hasPrimes: boolean;
  dwdConfigured: boolean;
  authConfigured: boolean;
  projectId: string;
  dwdSignerSA: string;
  dwdClientId: string;
  agentEmailDomain: string;
  artifactsRootFolderId: string;
}

/* ---- Work Envelope types ---- */

export interface WorkEnvelope {
  id: string;
  type: 'R' | 'M' | 'C' | 'T';
  parent_id: string | null;
  owner: string;
  status: 'pending' | 'active' | 'complete' | 'failed' | 'waiting' | 'needs_input' | 'blocked' | 'cancelled' | 'archived' | 'awaiting_approval' | 'planned' | 'rejected' | 'timed_out' | 'needs_review';
  intent: string;
  title?: string;
  instruction: string;
  accept_criteria: string;
  context_summary: string | null;
  output: string | null;
  error: string | null;
  children: string[];
  depends_on?: string[];
  source_channel: string;
  source_meta: Record<string, unknown>;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
  iteration: number;
  blocker?: string | null;
  blocker_type?: string | null;
  blocked_at?: string | null;
  cancelled_at?: string | null;
  cancelled_reason?: string | null;
  project_id?: string | null;
  delivery_status?: string | null;
  plan_id?: string | null;
  // Idempotency & replay-safety fields (CP2-CP5)
  step_ledger?: Record<string, StepLedgerEntry>;
  claimed_by?: string | null;
  claimed_at_ms?: number | null;
  _cp_progress?: CheckpointProgress | null;
}

/** Step ledger entry — records a completed dispatch step for replay dedup */
export interface StepLedgerEntry {
  status: 'complete' | 'failed';
  agent: string;
  ts: string;
  durationMs: number;
  outputHash: string | null;
}

/** Checkpoint plan resume state — persisted for crash recovery */
export interface CheckpointProgress {
  checkpointIndex: number;
  taskIndex: number;
  allResults: Array<Record<string, unknown>>;
  checkpoints?: Array<Record<string, unknown>>;
  decision?: Record<string, unknown>;
}

export interface WorkHistoryEntry {
  prev_status: string;
  new_status: string;
  agent: string;
  detail: string;
  timestamp: string;
}

/* ---- Project types ---- */

export interface Project {
  id: string;
  name: string;
  goal: string;
  description: string;
  owner: string;
  status: 'active' | 'complete' | 'paused' | 'archived';
  parent_id: string | null;
  depends_on: string[];
  team: string[];
  created_by: string;
  drive_folder_id?: string;
  drive_url?: string;
  context: {
    documentation: string[];
    processes: string[];
    team: Record<string, string>;
    configuration: Record<string, unknown>;
  } | null;
  created_at: string;
  updated_at: string;
}

/* ---- Plan types ---- */

export interface Plan {
  id: string;
  project_id: string;
  name: string;
  process_id: string | null;
  process_version: number | null;
  parameters: Record<string, unknown>;
  layout: {
    mission: { instruction: string; accept_criteria: string; owner: string };
    checkpoints: {
      instruction: string;
      accept_criteria: string;
      tasks: { instruction: string; accept_criteria: string; agent: string }[];
    }[];
  };
  mission_id: string | null;
  amendments: { timestamp: string; reason: string; changes: string; amended_by: string }[];
  status: 'draft' | 'approved' | 'executing' | 'complete' | 'abandoned';
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

/* ---- Active status constants ---- */

/** Canonical set of statuses considered "active" for work tree display */
export const ACTIVE_STATUSES = new Set<string>([
  'active', 'waiting', 'needs_input', 'awaiting_approval', 'blocked', 'needs_review', 'timed_out', 'queued',
]);

/** Array version for Firestore `in` queries (max 30) */
export const ACTIVE_STATUSES_ARRAY = [...ACTIVE_STATUSES];
