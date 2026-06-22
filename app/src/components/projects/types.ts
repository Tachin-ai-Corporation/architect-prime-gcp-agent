import type { ContextEntry } from "./ContextEditor";
import type { Canon } from "./CanonEditor";

export interface ProjectSummary {
  id: string;
  name: string;
  goal: string;
  owner: string;
  status: "active" | "complete" | "completed" | "paused" | "archived";
  description: string;
  parent_id: string | null;
  depends_on: string[];
  team?: string[];
  created_by?: string;
  drive_folder_id?: string;
  drive_url?: string;
  missionCount: number;
  completedMissions: number;
  participants: string[];
  created_at: string;
  context?: {
    documentation?: string[];
    processes?: string[];
    team?: Record<string, string>;
  } | null;
}

export interface ProjectDetail extends ProjectSummary {
  context: Record<string, ContextEntry>;
  standardProcesses?: string[];
  canon?: Canon;
}

export interface ProcessSummary {
  id: string;
  name: string;
  description: string;
  status: "active" | "deprecated";
  version: number;
  execution_count: number;
  created_by: string;
  created_at: string;
  steps: { title: string }[];
}

export interface PromotionEntry {
  id: string;
  contextKey: string;
  kind: string;
  name: string;
  summary: string;
  sourceMissionId: string;
  created_at: string;
  status: "pending" | "accepted" | "dismissed";
}
