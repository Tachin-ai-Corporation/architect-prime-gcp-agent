---
name: Fresh Install Contamination Audit
description: >
  Scan repo files for operator-specific contamination that would break a fresh
  fork. The mandatory gate before any REPO-tier PR.
---

# Fresh Install Contamination Audit

> **Agent part:** motor
> **Purpose:** Detect operator-specific values (hardcoded project IDs, emails, Drive IDs, org names, Cloud Run URLs) in platform files that should be generic.

## When to use

- **Mandatory** before every REPO-tier PR landing (called by the `repo-improvement` skill)
- **Optional** for periodic repo hygiene audits

## Tool

### `fresh-install-scan`

```
fresh-install-scan <repo-root> [options]
```

| Option | Description | Default |
|---|---|---|
| `--operator-terms "<terms>"` | Comma-separated operator-specific terms to scan for | (none — uses built-in patterns) |
| `--severity-min <level>` | Minimum severity to report: `info`, `medium`, `high`, `critical` | `info` |
| `--files "<glob>"` | Only scan files matching this glob (e.g. `"skills/**/*.md"`) | All non-excluded files |
| `--exclude "<glob>"` | Exclude files matching this glob | `node_modules/,*.lock,operator/` |
| `--json` | Output in JSON format | Human-readable |

### What it scans for

| Category | Examples | Severity |
|---|---|---|
| Real email addresses | `someone@their-domain.com` (not `@example.com`) | high |
| Real GCP project IDs | `my-actual-project-123` | high |
| Real Drive/Space IDs | Long alphanumeric IDs in Drive URLs | high |
| Real org/company names | Hardcoded company name in non-example context | high |
| Real Cloud Run URLs | `*.run.app` URLs with real service names | critical |
| Real API keys/secrets | Anything resembling a key | critical |

### What is excluded by default

- `operator/` tree (this is where operator values belong)
- `node_modules/`, lockfiles, minified bundles
- Lines containing `example`, `placeholder`, `YOUR_`, `fake`, `dummy` (these are intentional generics)

## Procedure

### Step 1 — Run the scan

```bash
fresh-install-scan . --operator-terms "your-org,your-email@company.com" --severity-min high
```

### Step 2 — Interpret results

| Result | Meaning | Action |
|---|---|---|
| `0 findings` | Clean — safe to PR | Proceed with `repo-improvement` landing |
| `N findings on your changed files` | Your changes introduced contamination | Fix: parameterize the values, or reclassify to LOCAL |
| `N findings on other files` | Pre-existing contamination (not yours) | Note for a future cleanup sweep; your PR is still OK |

### Step 3 — Fix contamination (if found)

For each finding on your changed files:
1. Replace the operator value with a generic placeholder (`YOUR_GITHUB_ORG`, `@example.com`, `your-gcp-project`)
2. Or replace with an env-var / metadata lookup if the value is needed at runtime
3. Re-run the scan to confirm clean

## Error Recovery

| Error | Recovery |
|---|---|
| Scan tool not found | Verify `fresh-install-scan` is installed via `role-prime.txt` manifest. Run `which fresh-install-scan`. |
| False positive on an example value | The value should contain `example`, `placeholder`, `YOUR_`, `fake`, or `dummy` to be auto-excluded. Rename it. |
| Scan flags a value in `operator/` | This is excluded by default. If it's showing up, check the `--exclude` option. |

## Worked Example

**Scenario:** Audit before PR for workspace-docs skill improvement.

```bash
$ fresh-install-scan . --operator-terms "tachin,chill@" --severity-min high --files "skills/workspace-docs/**"

Fresh Install Scan — skills/workspace-docs/
============================================
Files scanned: 3
Findings: 0 (high+)

✅ Clean — no operator contamination detected.
```

Result: safe to open the PR via `repo-improvement` skill.
