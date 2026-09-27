# operator/

This directory contains **operator-specific** content that has been separated from the
platform codebase. The platform (architect-prime) is generic and reusable; everything
under `operator/` is specific to a particular deployment or organization.

## Directory Structure

```
operator/
├── agents/            # Records of individual agents' OWN responsibilities (never installed)
├── docs/              # Operator-specific design docs, plans, and references
├── manifests/         # Job manifests for install.sh --job <name>
├── processes/         # Operator-specific process definitions (JSON)
├── responsibilities/  # Operator-specific responsibility configs
└── sites/             # Operator-managed website source files
```

## How It Works

The platform's `install.sh` uses **manifest files** to copy content onto agent VMs.
The base manifest (`manifests/base.txt`) contains only platform-generic files.

Operator content is installed via **job manifests** in `operator/manifests/`. Each job
manifest maps files from `operator/` into the paths expected on the VM.

### Installing operator content

```bash
# Install base platform + a specific operator job
./install.sh --job tachin-website
```

This reads `operator/manifests/job-tachin-website.txt` and copies each file from its
`operator/` source path to the corresponding VM destination path.

## An agent's own responsibilities (`agents/`)

A duty this deployment gives one agent, such as Millie's weekly executive update, is **that agent's own
responsibility**. It lives in the agent's responsibility store in Firestore and changes with
`responsibility-manage`, either on the agent or from Prime with `--agent <id>`. A change is live within a
minute, with no release and no upgrade. `agents/<agent>/responsibilities.json` is only the operator's git
record of it. No manifest installs it, because anything a manifest installs is reinstalled on the next
upgrade over the agent's own changes. Use it to re-create a responsibility if the store is ever lost, and
keep it in step with the store if you want the history in git.

## Adding New Operator Content

1. Place your files under the appropriate `operator/` subdirectory
2. Create or update a job manifest in `operator/manifests/`
3. Each manifest line: `<source-in-repo> <destination-on-vm>`
4. Lines starting with `#` are comments

## Why Separate?

- **Clean platform**: The core platform stays generic and forkable
- **Clear ownership**: Operator content is clearly scoped and auditable
- **Selective install**: Only deploy what each agent actually needs
- **No conflicts**: Platform updates don't risk overwriting operator customizations
