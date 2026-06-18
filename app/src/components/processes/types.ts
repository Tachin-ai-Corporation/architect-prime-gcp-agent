import type { ContextEntry } from "@/components/projects/ContextEditor";

export interface StepDef {
  title: string;
  description: string;
  agent: string;
  type: "standard" | "delegation" | "spawn_responsibility" | "approval_gate";
  optional?: boolean;
  checkpointBoundary?: boolean;
}

export interface ParamDef {
  key: string;
  type: string;
  default: string;
  description: string;
}

export interface ChangelogEntry {
  version: number;
  timestamp: string;
  author: string;
  summary: string;
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
  steps: StepDef[];
  intent_keywords?: string[];
}

export interface ProcessDetail extends ProcessSummary {
  parameters: Record<string, ParamDef>;
  contextTemplate: Record<string, ContextEntry>;
  changelog: ChangelogEntry[];
  visibility: string;
  updated_at?: string;
}
