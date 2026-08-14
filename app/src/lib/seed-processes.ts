// lib/seed-processes.ts — Idempotent seeder for core processes (p-plan, p-investigate)
// Original module
// Used by api/primes/[id]/deploy and api/primes/[id]/fleet/hire
//
// Seeds core process definitions into the shared processes/ collection.
// Processes are narrative playbooks — prose describing "how we've done this kind
// of work well before". No steps, parameters, or checkpoint machinery.
// Skips if already at current version.

import { processesCol } from "./firestore";

const CORE_PROCESS_VERSION = 2;

interface CoreProcess {
  id: string;
  name: string;
  description: string;
  narrative: string;
  intent_keywords: string[];
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
    "How we turn a goal into a reviewable plan with checkpoints, acceptance criteria, and honest risk classification.",
  narrative:
    "When we plan work well, we start by restating the goal in a single sentence and drawing a clear line around what is in scope and what is not. Before inventing anything new, we recall how similar goals were handled before — the patterns that worked, the lessons that stuck, the checkpoint structures worth reusing — and we only reach for outside research when the domain is genuinely unfamiliar. From there we shape the work into a handful of checkpoints (three to seven is usually right), each with a plain name and an explicit sense of what \"done\" looks like, along with its dependencies and rough effort. We are candid about risk: routine work is marked low, work with real unknowns or a large blast radius is marked high, and anything high-risk earns an approval conversation before we act. The plan is written down where the team can see it, and if it carries serious risk we surface that plainly and ask before proceeding rather than pressing ahead.",
  intent_keywords: ["plan", "planning", "roadmap", "scope", "checkpoints", "design"],
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
    "How we turn a question or symptom into evidenced findings, with hypotheses, an evidence trail, and recommendations.",
  narrative:
    "Good investigations begin by parsing the question honestly — separating what we actually know from what we are only assuming — and stating one to three falsifiable hypotheses along with the evidence that would confirm or refute each. We look first at whether this symptom has appeared before, drawing on prior occurrences and related error patterns, and we research the unfamiliar only when there is a real knowledge gap. With that context we rank the hypotheses by prior likelihood and go gather direct evidence for the most promising ones — running commands, reading files, scanning logs, querying APIs — and we report what we find verbatim rather than paraphrasing it into a conclusion. We then weigh the quality of that evidence, flagging anything unverified or circumstantial, and we rate our confidence plainly: confirmed, likely, inconclusive, or refuted. Finally we synthesize findings into a clear root cause where one is proven, the evidence behind it, and actionable next steps — and when nothing is confirmed we say so, naming what is known and what still needs digging.",
  intent_keywords: ["investigate", "debug", "diagnose", "root cause", "why", "incident"],
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
 * Idempotent: skips if the doc exists with origin=core and same (or newer) version.
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

    // Create or overwrite with the narrative shape
    const now = new Date().toISOString();
    await docRef.set({
      name: proc.name,
      description: proc.description,
      narrative: proc.narrative,
      intent_keywords: proc.intent_keywords,
      origin: proc.origin,
      version: proc.version,
      visibility: proc.visibility,
      compatibility: proc.compatibility,
      status: proc.status,
      created_at: now,
      updated_at: now,
      updated_by: "system",
    });
    seeded.push(proc.id);
  }

  return { seeded, skipped };
}
