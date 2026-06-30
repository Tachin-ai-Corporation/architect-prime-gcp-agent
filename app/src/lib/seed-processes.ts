// lib/seed-processes.ts — Idempotent seeder for core processes (p-plan, p-investigate)
// Original module
// Used by api/primes/[id]/deploy and api/primes/[id]/fleet/hire
//
// Seeds core process definitions into the shared processes/ collection.
// Skips if already at current version.

import { processesCol } from "./firestore";

const CORE_PROCESS_VERSION = 1;

interface ProcessStep {
  title: string;
  type: "standard" | "delegation" | "approval_gate";
  agent: string;
  instruction: string;
  on_fail?: string;
  optional?: boolean;
}

interface CoreProcess {
  id: string;
  name: string;
  description: string;
  steps: ProcessStep[];
  parameters: Record<string, { type: string; required: boolean; description: string; default?: unknown }>;
  origin: "core";
  version: number;
  visibility: "shared";
  compatibility: string[];
  status: "active";
}

/* ------------------------------------------------------------------ */
/*  p-plan — Generic Planning Process                                 */
/* ------------------------------------------------------------------ */
const P_PLAN: CoreProcess = {
  id: "p-plan",
  name: "Plan",
  description:
    "Decompose a goal into a reviewable plan with checkpoints, acceptance criteria, and risk classification. Output: PLAN.md in the agent's workspace and structured envelope hierarchy.",
  steps: [
    {
      title: "Restate & Scope",
      type: "standard",
      agent: "cortex",
      instruction:
        "Restate the goal in one sentence. Identify scope, target outcomes, in-scope and out-of-scope items. If a project_id is provided, load project context first.",
    },
    {
      title: "Recall Prior Plans",
      type: "delegation",
      agent: "temporal-memory",
      instruction:
        "Search core memory and recent sessions for prior plans related to this goal. Return relevant patterns, lessons learned, and reusable checkpoint structures.",
    },
    {
      title: "External Research",
      type: "delegation",
      agent: "temporal-research",
      instruction:
        "Only if external knowledge is needed (new technology, vendor docs, regulations, unfamiliar domain). Skip if the goal is well-understood. Research and return key findings.",
      optional: true,
      on_fail: "skip",
    },
    {
      title: "Propose Checkpoints",
      type: "standard",
      agent: "cortex",
      instruction:
        "Using context from prior steps, propose 3–7 checkpoints. Each checkpoint must have: a clear name, explicit acceptance criteria (what 'done' looks like), estimated effort, and dependencies on other checkpoints.",
    },
    {
      title: "Risk Classification",
      type: "standard",
      agent: "cortex",
      instruction:
        "Classify each checkpoint by risk: LOW (routine, well-understood), MEDIUM (some unknowns, moderate blast radius), HIGH (novel, large blast radius, hard to reverse). HIGH checkpoints get an approval gate before execution.",
    },
    {
      title: "Write Plan Document",
      type: "delegation",
      agent: "motor",
      instruction:
        "Write workspace/PLAN.md with the full plan structure: Goal, Scope, Checkpoints (table with name, acceptance criteria, risk, effort, dependencies), Timeline, Risks & Mitigations. Use markdown formatting.",
    },
    {
      title: "Approval Gate",
      type: "approval_gate",
      agent: "cortex",
      instruction:
        "If any HIGH-risk checkpoint exists OR requires_approval parameter is true, present the plan for operator approval before proceeding. Summarize the plan with emphasis on HIGH-risk items.",
      optional: true,
    },
  ],
  parameters: {
    goal: { type: "string", required: true, description: "The goal to plan for" },
    project_id: { type: "string", required: false, description: "Link to an existing project for context" },
    requires_approval: { type: "boolean", required: false, description: "Force approval gate regardless of risk", default: false },
    time_budget_hours: { type: "number", required: false, description: "Optional time budget constraint" },
  },
  origin: "core",
  version: CORE_PROCESS_VERSION,
  visibility: "shared",
  compatibility: ["*"],
  status: "active",
};

/* ------------------------------------------------------------------ */
/*  p-investigate — Generic Investigation Process                     */
/* ------------------------------------------------------------------ */
const P_INVESTIGATE: CoreProcess = {
  id: "p-investigate",
  name: "Investigate",
  description:
    "Turn a question or symptom into evidenced findings. Output: INVESTIGATION.md with hypotheses, evidence trail, and recommendations.",
  steps: [
    {
      title: "Parse & Hypothesize",
      type: "standard",
      agent: "cortex",
      instruction:
        "Parse the question or symptom. List what is known vs unknown. State 1–3 falsifiable hypotheses if possible. Identify what evidence would confirm or refute each hypothesis.",
    },
    {
      title: "Recall Prior Occurrences",
      type: "delegation",
      agent: "temporal-memory",
      instruction:
        "Search core memory for prior occurrences of this symptom, related error patterns, or similar investigations. Return matches with dates and outcomes.",
    },
    {
      title: "External Research",
      type: "delegation",
      agent: "temporal-research",
      instruction:
        "Only if a domain knowledge gap is identified (unfamiliar error, new service, external dependency). Research and return relevant documentation, known issues, or solutions.",
      optional: true,
      on_fail: "skip",
    },
    {
      title: "Rank Hypotheses",
      type: "standard",
      agent: "cortex",
      instruction:
        "Using context from memory and research, produce a rank-ordered hypothesis list with prior likelihood (HIGH/MEDIUM/LOW). Identify the top 1–3 hypotheses worth investigating and the evidence needed for each.",
    },
    {
      title: "Gather Evidence",
      type: "delegation",
      agent: "motor",
      instruction:
        "Gather direct evidence for the top hypotheses. Run commands, read files, scan logs, query APIs as needed. For each hypothesis, collect confirming or refuting evidence. Report raw evidence verbatim.",
    },
    {
      title: "Evaluate Evidence Quality",
      type: "delegation",
      agent: "cerebellum",
      instruction:
        "Evaluate the quality of evidence gathered. Flag what is unverified or circumstantial. Confirm which hypotheses are supported, refuted, or inconclusive. Rate confidence: CONFIRMED / LIKELY / INCONCLUSIVE / REFUTED.",
    },
    {
      title: "Synthesize Findings",
      type: "standard",
      agent: "cortex",
      instruction:
        "Produce findings: confirmed root cause (if found), supporting evidence, confidence level, and actionable recommendations (next steps, preventive measures). If no root cause confirmed, state what is known and what further investigation is needed.",
    },
    {
      title: "Write Investigation Report",
      type: "delegation",
      agent: "motor",
      instruction:
        "Write workspace/INVESTIGATION.md with the full report: Question, Hypotheses (table), Evidence Trail, Findings, Recommendations. If the finding is material (new error pattern, architectural insight), also write to core memory.",
    },
  ],
  parameters: {
    question: { type: "string", required: true, description: "The question to investigate or symptom to diagnose" },
    symptom_evidence: { type: "string", required: false, description: "Any initial evidence or error messages" },
    scope_hint: { type: "string", required: false, description: "Hint about where to look (service, component, timeframe)" },
  },
  origin: "core",
  version: CORE_PROCESS_VERSION,
  visibility: "shared",
  compatibility: ["*"],
  status: "active",
};

/* ------------------------------------------------------------------ */
/*  Seeder                                                            */
/* ------------------------------------------------------------------ */

const CORE_PROCESSES = [P_PLAN, P_INVESTIGATE];

/**
 * Seed core processes into the shared processes collection.
 * Idempotent: skips if the doc exists with origin=core and same version.
 */
export async function seedCoreProcesses(_primeId?: string): Promise<{ seeded: string[]; skipped: string[] }> {
  const col = processesCol();
  const seeded: string[] = [];
  const skipped: string[] = [];

  for (const proc of CORE_PROCESSES) {
    const docRef = col.doc(proc.id);
    const existing = await docRef.get();

    if (existing.exists) {
      const data = existing.data();
      // Skip if same version and origin is core
      if (data?.origin === "core" && data?.version >= proc.version) {
        skipped.push(proc.id);
        continue;
      }
    }

    // Create or overwrite
    const now = new Date().toISOString();
    await docRef.set({
      name: proc.name,
      description: proc.description,
      steps: proc.steps,
      parameters: proc.parameters,
      origin: proc.origin,
      version: proc.version,
      visibility: proc.visibility,
      compatibility: proc.compatibility,
      status: proc.status,
      created_at: now,
      created_by: "system",
      execution_count: 0,
      changelog: [],
    });
    seeded.push(proc.id);
  }

  return { seeded, skipped };
}
