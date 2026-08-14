import type { ContextEntry } from "./ContextEditor";
import type { Canon } from "./CanonEditor";
import type { ProjectTeamMember } from "@/lib/types";

export interface ProjectSummary {
  id: string;
  name: string;
  goal: string;
  owner: string;
  status: "active" | "complete" | "completed" | "paused" | "archived";
  description: string;
  parent_id: string | null;
  depends_on: string[];
  team?: ProjectTeamMember[];
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
  // Authoritative deploy target (hosting site vs GCP project kept distinct).
  deploy?: {
    platform: string;
    gcp_project?: string;
    hosting_site?: string;
    source?: { kind: string; ref: string } | null;
    flow?: string;
  };
}

export interface ProcessSummary {
  id: string;
  name: string;
  description: string;
  narrative?: string;
  status: "active" | "deprecated";
  version: number;
  intent_keywords?: string[];
  updated_at?: string;
  updated_by?: string;
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
