# Skill: skill-authoring

## What this skill does
Generate and validate skill packages from observed patterns. Creates
well-formed `skill.json` + `SKILL.md` packages that can be submitted
to the skill registry.

## When to use
When Cortex dispatches you to create a new skill from discovered patterns,
or to validate an existing skill package before deployment.

---

## Tools

### skill-author

#### create — Generate a new skill package

```
exec skill-author create \
  --id <id> \
  --name <name> \
  --description <desc> \
  --agent-part <part> \
  --category <cat> \
  --when-to-use <when> \
  [--origin learned] \
  [--author <author>] \
  [--output-dir <dir>] \
  [--skill-md <full-content>]
```

**Required flags:**
| Flag | Description |
|------|-------------|
| `--id` | Skill ID (lowercase, hyphens, e.g. `brand-image-check`) |
| `--name` | Human-readable name (e.g. `Brand Image Compliance`) |
| `--description` | What the skill does — used to generate SKILL.md |
| `--agent-part` | Brain agent: `motor`, `cerebellum`, `temporal-research`, `cortex`, `prefrontal` |
| `--category` | Category: `workspace`, `fleet`, `search`, `memory`, `infrastructure`, `verification`, `custom` |
| `--when-to-use` | When this skill should be invoked |

**Optional flags:**
| Flag | Default | Description |
|------|---------|-------------|
| `--origin` | `learned` | Origin: `core`, `specialty`, `learned` |
| `--author` | Current agent identity | Author attribution |
| `--output-dir` | `workspace/skill-staging` | Output directory for the package |
| `--skill-md` | — | Full SKILL.md content (skips auto-generation) |

**Output:** Creates `<output-dir>/<id>/skill.json` and `<output-dir>/<id>/SKILL.md`

**Example:**
```bash
exec skill-author create \
  --id firebase-deploy-check \
  --name "Firebase Deploy Verification" \
  --description "After running firebase deploy, fetch the deployment URL and verify the page loads correctly." \
  --agent-part cerebellum \
  --category verification \
  --when-to-use "After any Firebase Hosting deployment to verify the site is live"
```

#### validate — Validate an existing skill package

```
exec skill-author validate --dir <skill-dir>
```

Checks for:
- `skill.json` exists with required fields: `id`, `name`, `version`, `description`, `agent_part`, `origin`, `when_to_use`
- Valid `agent_part` value
- `SKILL.md` exists with minimum content (≥5 lines)

Returns `PASS` or `ERRORS: N validation failures`.

**Example:**
```bash
exec skill-author validate --dir workspace/skill-staging/firebase-deploy-check
```

#### list-parts — Show valid agent_part values

```
exec skill-author list-parts
```

Outputs:
- `motor` — Execution tools (Drive, Gmail, shell commands, fleet ops)
- `cerebellum` — Verification and validation tools
- `temporal-research` — Web search and URL fetching tools
- `cortex` — Decision and classification tools (rare)
- `prefrontal` — Planning tools (rare)

## Workflow
1. Create the skill package with `skill-author create`
2. Review and refine the generated `SKILL.md`
3. Validate with `skill-author validate`
4. Submit for approval via Firestore skill-registry
