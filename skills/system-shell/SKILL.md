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

### Edit a file in place — surgically, and mind the quote trap
Changing text in an existing file (HTML/CSS/code/config) is a *surgical* edit: change the
smallest unique span and leave the rest byte-for-byte identical. HOW you make the edit decides
whether you quietly corrupt the file.

- **Match the smallest unique token — never a whole block.** To retitle one heading, target just
  that text: `sed -i 's/>Proof</>The proof</' index.html`. Do NOT build a multi-line `sed` whose
  pattern is a big chunk of surrounding markup — basic `sed` cannot match across newlines, so it
  fails and you retry blind.
- **THE QUOTE TRAP — this silently corrupts files.** A `sed 's/…/…/'` program is wrapped in
  single quotes by the shell. If the text inside contains an apostrophe or quote — `payor's`,
  `class="x"`, an inline `<script>` using `'.reveal'` — the shell escaping turns every `'` into
  `\'` and **writes the backslashes into the file**. One heading edit that drags a quoted block
  through `sed` can mangle dozens of quotes across the file and break inline JS, so the page
  renders blank below the first broken script. If the span you must match or insert contains any
  quote, do NOT hand it to inline `sed`.
- **Beyond a tiny quote-free token, don't use inline `sed` at all.** Read the file, then rewrite
  it with `writeFile` (literal bytes — no shell escaping), or run a small `python3` replace
  (`s=open(p).read().replace(OLD,NEW,1); open(p,'w').write(s)`) — string ops never shell-escape.
- **Prove you didn't corrupt it.** After the edit, `git diff --stat` (or `work-diff --stat`) must
  show ~the lines you meant — a one-word change is a 1–2 line diff, not the whole file — and
  `grep -n "\\'" FILE` must return nothing (a stray `\'` means you hit the quote trap: revert and
  redo with `writeFile`/`python3`).

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
| A one-line text edit produced a huge diff, left stray `\'`/`\"` in the file, or the page went blank below the first section | Inline `sed 's/…/…/'` whose pattern/replacement contained apostrophes or quotes — the shell escaped them into the file, breaking inline JS | Revert the file; redo as the smallest quote-free token, or via `writeFile`/`python3` `.replace()` (literal, no shell escaping). Verify `git diff --stat` is minimal and `grep "\\'" FILE` is empty |
