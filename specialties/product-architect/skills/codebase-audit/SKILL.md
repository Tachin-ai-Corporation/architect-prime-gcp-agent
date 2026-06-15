# Skill: Codebase Audit

## What this skill does
Read-only codebase analysis with discovery-driven focus rotation.

## When to use
When auditing a codebase — analyzing code structure, checking standards
compliance, reviewing architecture and contracts.

## Audit Protocol

### Step 1: Read Standards (MANDATORY)

Before any analysis, read the project's architecture standards and invariant
documents. Check the project context for their locations — do not assume
file paths.

### Step 2: Gather Context

Review prior learnings from the active audit responsibility (if one exists).
Recall relevant Core Memory entries about the project's architecture and
patterns.

### Step 3: Discover Module Structure

Do not assume directory layout. Discover the project's structure:
- Examine the top-level directories and key configuration files.
- Identify the major subsystems and their boundaries.
- Check for architecture documentation within the project.

### Step 4: Inspect Focus Area

Rotate through the project's subsystems systematically. For each focus area:
1. Read key files in the subsystem.
2. Check for: code duplication, unclear naming, missing error handling,
   inconsistent patterns, unnecessary complexity.
3. Verify compliance with the project's declared invariants.
4. Assess against the project's quality dimensions.

### Step 5: Cross-Reference

After inspecting the focus area, check cross-cutting concerns:
- Are configuration values centralized as the project requires?
- Are deployment manifests consistent with the codebase?
- Is there test coverage for the inspected modules?
- Is documentation consistent with the code?

### Step 6: Rank Findings

For each finding, score against the project's quality rubric:

```
Finding: <description>
Dimension: <which quality dimension improves>
Measure: <quantitative or structural improvement>
Protected Properties: <confirm all untouched>
Risk: <low | medium | high>
Scope: <file globs>
```

Select the single highest-value finding for the improvement proposal.

## Important Constraints

- **READ-ONLY**: This skill is strictly observational. Do not modify any files.
- **Single improvement per cycle**: Propose exactly one improvement, the
  highest-value one.
- **Evidence-based**: Every finding must cite specific files and line numbers.
- **Standards-compliant**: Every proposal must pass the project's standards
  filters before being submitted.
