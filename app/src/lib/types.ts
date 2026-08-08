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
  attachments?: { name: string; size: number; gcsPath: string }[];
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
  githubOwner?: string;
  githubRepo?: string;
}

/* ---- Work Envelope types ---- */

export interface SourceMeta {
  senderEmail: string | null;
  senderDisplayName: string | null;
  senderUserId: string | null;
  space?: string;
  thread?: string;
  [key: string]: unknown;
}

export interface WorkEnvelope {
  id: string;
  type: 'R' | 'M' | 'C' | 'T';
  parent_id: string | null;
  owner: string;
  status: 'pending' | 'active' | 'complete' | 'failed' | 'waiting' | 'needs_input' | 'blocked' | 'cancelled' | 'archived' | 'awaiting_approval' | 'planned' | 'rejected' | 'timed_out' | 'needs_review' | 'queued';
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
  source_meta: SourceMeta;
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

/**
 * A member of a project team. Stored on `projects/{id}.team[]` as objects.
 * `responsibilities` is free-text used by the agent fleet for delegation
 * routing. Older records may store bare email strings — use `normalizeTeam`
 * to coerce mixed data into this shape before reading.
 */
export interface ProjectTeamMember {
  email: string;
  role?: string;
  name?: string;
  type?: string;
  responsibilities?: string;
}

export interface Project {
  id: string;
  name: string;
  goal: string;
  description: string;
  owner: string;
  status: 'active' | 'complete' | 'paused' | 'archived';
  parent_id: string | null;
  depends_on: string[];
  team: ProjectTeamMember[];
  created_by: string;
  drive_folder_id?: string;
  drive_url?: string;
  context: {
    documentation: string[];
    processes: string[];
    team: Record<string, string>;
    configuration: Record<string, unknown>;
  } | null;
  canon?: {
    authority: string[];
    entries: Array<{
      key: string;
      text: string;
      updated_at?: string;
      updated_by?: string;
    }>;
  };
  // Authoritative deploy target — the hosting site (deploy target) and GCP project are
  // DISTINCT fields so a devops agent never confuses one for the other.
  deploy?: {
    platform: string;
    gcp_project?: string;
    hosting_site?: string;
    source?: { kind: string; ref: string } | null;
    flow?: string;
  };
  created_at: string;
  updated_at: string;
}

/**
 * Coerce a possibly-legacy team array into `ProjectTeamMember` objects.
 * Legacy entries stored as bare email strings become `{ email }`; object
 * entries pass through with every field (incl. `responsibilities`) preserved,
 * so the full array can be safely written back to Firestore. Nullish/non-array
 * input yields an empty array.
 */
export function normalizeTeam(
  team: readonly (ProjectTeamMember | string)[] | null | undefined,
): ProjectTeamMember[] {
  if (!Array.isArray(team)) return [];
  return team.map((member) =>
    typeof member === "string" ? { email: member } : member,
  );
}

/* ---- Active status constants ---- */

/** Canonical set of statuses considered "active" for work tree display */
export const ACTIVE_STATUSES = new Set<string>([
  'active', 'waiting', 'needs_input', 'awaiting_approval', 'blocked', 'needs_review', 'timed_out', 'queued',
]);

/** Array version for Firestore `in` queries (max 30) */
export const ACTIVE_STATUSES_ARRAY = [...ACTIVE_STATUSES];
