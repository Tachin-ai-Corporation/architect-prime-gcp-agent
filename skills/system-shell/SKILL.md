# Skill: System Shell

## When to Use
When a task calls for general-purpose command-line work and no specific CoreKit
script covers it. This is your general problem-solving surface: navigate the
filesystem, process text and JSON, inspect logs and processes, chain standard
Unix tools. Reach for this when the answer is "just run some commands and figure
it out," not when a dedicated skill exists.

## Philosophy
You have a real shell. Use it the way a capable engineer would: compose small
tools, inspect before acting, verify after. You are not limited to a fixed menu
of commands — if a standard Unix tool solves the problem, use it. Prefer clarity
and reversibility; check state before making destructive changes.

## Available Tooling
Standard Ubuntu 24 userland is available via `runCommand`, including:

### Filesystem & navigation
- `ls`, `find`, `tree`, `stat`, `du`, `df`, `readlink`, `realpath`
- `cat`, `head`, `tail`, `less`, `wc`, `file`

### Text & data processing
- `grep` / `rg` (ripgrep), `sed`, `awk`, `cut`, `sort`, `uniq`, `tr`, `column`
- `jq` (JSON), `python3` (for anything structured — JSON, CSV, transforms)
- `diff`, `patch`, `comm`

### Process & service inspection
- `ps`, `top` (batch mode `top -bn1`), `pgrep`, `pkill`
- `systemctl status <svc>`, `journalctl -u <svc> --no-pager -n <N>`
- `ss`, `netstat`, `curl`, `wget`, `ping`

### Archives & transfer
- `tar`, `gzip`, `zip`/`unzip`, `scp`, `rsync`

### Scripting
- `bash` (write and run scripts), `python3` (write and run `.py` files)
- Standard editors are unnecessary — use `writeFile` to create scripts, then run them.

## Procedures

### Inspect before acting
1. Understand current state first: `ls -la`, `cat` the relevant file, `systemctl status`,
   `journalctl` the relevant service.
2. Form a hypothesis about what needs to change.
3. Make the change with the smallest reversible step.
4. Verify the change had the intended effect.

### Process structured data with python3 or jq
For JSON: `jq '.field' file.json` for simple extraction; `python3 -c "..."` for
transforms, validation, or multi-step logic.
For CSV/tabular: `python3` with `csv` module, or `awk`/`cut` for simple column work.

### Write and run a helper script
When a task needs more than a one-liner:
1. `writeFile` a script to `/tmp/<name>.sh` or `/tmp/<name>.py`.
2. Run it: `bash /tmp/<name>.sh` or `python3 /tmp/<name>.py`.
3. Capture and report stdout + stderr.

## Safety
- Inspect before destructive operations. `rm -rf`, mass `mv`, and permission changes
  are flagged: state what you're about to do and why before running them.
- Never echo, log, or write secret values (see the `secrets` skill).
- Capture stderr as well as stdout — failures are informative.
- One logical operation per step during execution; report the outcome.

## Error Recovery
| Symptom | Likely cause | Recovery |
|---|---|---|
| `command not found` | Tool not installed | Check with `which <tool>`; use an installed alternative (e.g. `rg`→`grep`, `tree`→`find`) |
| `permission denied` | File perms or privilege | `ls -la` the target; use `sudo` only if the task legitimately requires it |
| Command hangs | Waiting on input or long op | Commands time out at 2 min; add `-n`/non-interactive flags, or background long ops and poll |
| Empty output | Wrong path or filter | Verify the path exists and the filter matches; widen then narrow |
