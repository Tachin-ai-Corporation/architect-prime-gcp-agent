/* ---- Shared types for Architect Prime dashboard ---- */

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
  status: 'pending' | 'active' | 'complete' | 'failed' | 'waiting' | 'needs_input' | 'blocked' | 'cancelled' | 'archived' | 'awaiting_approval' | 'planned' | 'rejected' | 'timed_out';
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
  team: string[];              // prime/agent IDs with access
  created_by: string;          // who created this project
  drive_folder_id?: string;    // Google Drive folder ID
  drive_url?: string;          // Google Drive folder URL
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

