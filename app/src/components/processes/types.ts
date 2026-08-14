// Processes are narrative playbooks — prose describing "how we've done this
// kind of work well before". There is no step machinery: no steps, parameters,
// per-step agents, checkpoint boundaries, or approval gates.

export interface ProcessSummary {
  id: string;
  name: string;
  description: string;
  narrative: string;
  status: "active" | "deprecated";
  version: number;
  intent_keywords?: string[];
  updated_at?: string;
  updated_by?: string;
}

// Detail view carries the same narrative shape as the list summary.
export type ProcessDetail = ProcessSummary;
