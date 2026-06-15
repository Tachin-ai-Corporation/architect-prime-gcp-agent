# Skill: Repository Audit

## What this skill does
Read-only repo analysis playbook with focus rotation and raw-URL fetch patterns

## When to use
When auditing the repository — analyzing code structure, checking canon compliance, reviewing manifests and contracts

Read-only repository analysis playbook for identifying improvement opportunities. Uses focus rotation to prevent fixation and raw-URL fetch patterns for deep inspection.

## Audit Protocol

### Step 1: Re-Read Canon (MANDATORY)

Before any analysis, read both canon documents:

```bash
# Read PRODUCT_CANON.md — the walls (invariants)
exec cat docs/PRODUCT_CANON.md

# Read BRAIN_CANON.md — the gradient (what better looks like)
exec cat docs/BRAIN_CANON.md
```

### Step 2: Gather Context

```bash
# Read prior_learnings from the responsibility
responsibility-manage show --id r-repo-improvement

# Recall relevant Core Memory
core-memory-read --category architecture --limit 10
core-memory-read --category patterns --limit 10
```

### Step 3: Inspect Focus Area

Use the focus rotation parameter to determine which area to audit:

| Focus Area | Commands |
|-----------|----------|
| `corekit/brain` | `exec find corekit/brain -name '*.md' -o -name '*.mjs'` then read key files |
| `corekit/lib` | `exec find corekit/lib -name '*.mjs'` then read key files |
| `corekit/daemon` | `exec find corekit/daemon -name '*.mjs'` then read key files |
| `infra` | `exec find infra -name '*.txt' -o -name '*.json' -o -name '*.sh'` then read key files |

For each file in the focus area:
1. Read the file content.
2. Check for: code duplication, unclear naming, missing error handling, inconsistent patterns, unnecessary complexity.
3. Verify compliance with PRODUCT_CANON invariants.
4. Assess against BRAIN_CANON quality axes.

### Step 4: Cross-Reference

After inspecting the focus area, check for cross-cutting concerns:
- **Contracts**: Are all external coordinates in `contracts.json`?
- **Manifests**: Do manifests reference all files that should be deployed?
- **Tests**: Is there test coverage for the inspected modules?
- **Documentation**: Are docs consistent with the code?

### Step 5: Rank Findings

For each finding, score against the BRAIN_CANON Part IV rubric:

```
Finding: <description>
Axis: <efficiency | structure | logic clarity | cleanness>
Measure: <quantitative or structural improvement>
Protected: determinism ✅ | idempotency ✅ | observability ✅ | testability ✅
Risk: <low | medium | high>
Scope: <file globs>
```

Select the single highest-value finding for the improvement proposal.

## Focus Rotation

The audit cycles through focus areas to ensure comprehensive coverage:

| Cycle | Parameter Value | Area |
|-------|----------------|------|
| 1 | `brain` | `corekit/brain/**` — brain agents, prompts, soul files |
| 2 | `lib` | `corekit/lib/**` — shared libraries, schedulers, utilities |
| 3 | `daemon` | `corekit/daemon/**` — ears/brain/mouth daemons |
| 4 | `infra` | `infra/**`, `corekit/config/**` — manifests, contracts, config |

The focus area is passed as the `focus_area` process parameter.

## Important Constraints

- **READ-ONLY**: This skill is strictly observational. Do not modify any files.
- **Single improvement per cycle**: Propose exactly one improvement, the highest-value one.
- **Evidence-based**: Every finding must cite specific files and line numbers.
- **Canon-compliant**: Every proposal must pass both canon filters before being submitted.
