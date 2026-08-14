# Skill: Coding (implement in a codebase)

## When to Use
Implementing or changing code in an **existing repository** — building a feature, wiring up
functionality, fixing a bug, or turning a design/mockup into working code — and leaving the
repo **running**. Not a throwaway one-off (just write and run a script); not reviewing
someone else's diff (that is code-review). Here you change a real codebase and prove it works.

## Work like an engineer — understand first, change the smallest thing that works, prove it runs
Do NOT open a file and start typing. A change lands well only when you understand what you are
touching and you have watched it work.

1. **Understand the codebase.** Read what declares the stack and how it runs — a manifest
   (`package.json`, `pyproject.toml`/`requirements.txt`, `go.mod`, `Cargo.toml`, `Gemfile`…),
   a README, a config. If there is none, it is likely a plain static/site or script repo — say
   so. Map the structure: entry points, where pages/components/routes/models/styles/config
   live, how a request or a render flows through. Learn the conventions by **reading existing
   code that already does something similar** — naming, framework idioms, file layout, how
   state and data move. You are going to match this, not replace it. Note the project's own
   **build / test / run** commands (from its manifest scripts or README) — you will use those,
   not invent your own.

2. **Locate the change surface by reading, not guessing.** Find the exact files and functions
   to touch. Trace how the current behaviour works before you extend it. **Edit the real,
   existing file** — the one the task names (e.g. `index.html`) or the actual entry file the
   app/site uses. NEVER invent a new filename or create a parallel file (writing `home.html`
   when the page is `index.html`, or a `*-new` copy) — that leaves the real file untouched and
   the change invisible. In a noisy repo, separate real source from artifacts (generated files,
   notes, transcripts, duplicated/`-main` copies, `node_modules`, build output): confirm which
   file the running site/app actually serves, and change THAT — never a copy or generated output.

3. **Implement idiomatically.** Write code that reads like the code around it — its naming,
   its patterns, its structure. **Wire it end-to-end**: a feature is not a stub — the data
   flows, the handler fires, the state renders, the styles apply. Turning a design into code
   means real markup **and** its styles **and** the behaviour that makes it function, matching
   the project's design system / component library where one exists. Make the **smallest change
   that fully achieves the outcome**; reuse what is there; do not refactor, rename, or reformat
   things you were not asked to touch.

4. **Run it and verify locally — do not assume.** Install dependencies if the project needs
   them (its own package manager). Run the project's **build**, its **tests**, and the **thing
   itself** — start the dev server and hit it, run the CLI, or for a static site serve it and
   fetch the page. Confirm the change is actually present and behaves as intended, and that you
   did not break what was working. Read the output and errors; fix the **cause** and re-run
   until it is clean. "It should work" is not "it works."

5. **Prove the real file changed, then leave the tree green.** Run `work-diff` / `work-status`
   and CONFIRM the exact file(s) you meant to change are the ones that actually changed, with
   your change in them. **If the diff does not show your intended source file changed — or shows
   a new/renamed file you didn't intend — you have NOT implemented it** (you edited the wrong
   path, or only produced the code as text): go back, edit the real file, and re-check the diff.
   The deliverable is the changed file proven by the diff, never a description of the change.
   Then confirm it builds / renders / tests pass, only the files you meant are touched (no stray
   files, debug leftovers, or secrets), and commit + sync through the git flow (see "The
   substrate"). Do not commit a red or empty-of-your-change tree.

## Principles — the difference between "wrote code" and "shipped a working change"
- **Read before you write.** The codebase already answers most "how should I…" questions.
- **Verify the current state — don't trust memory that it's already done.** Before concluding a
  change already exists (and declining to make it), confirm it in the CURRENT code — read the
  file, check `work-diff`. A memory that a past mission did it is NOT proof the code is in that
  state (that mission may have failed or touched the wrong file). If the task asks for it and it
  is not there now, implement it.
- **Match the house style.** Foreign patterns are a defect even when they "work" — the next
  change has to live beside yours.
- **Make it actually run.** Verification is watching it work, not believing it will.
- **Smallest change that achieves the outcome.** No gold-plating, no drive-by refactors, no
  reformatting unrelated lines (it buries your real change and breaks blame).
- **Wire it end-to-end.** A design isn't done until it renders; a feature isn't done until it
  functions.
- **Leave the tree green.** It builds, it renders, its tests pass — before you commit.
- **Errors are information.** Read them fully; they usually name the file, line, and cause.
- **Use the project's own tooling.** Its build/test/lint/run commands, its package manager, its
  conventions — never impose a different toolchain onto a repo that already has one.

## The substrate: you work in a git-backed repo (workspace-git)
The brain daemon **auto-clones the mission's project repo** into your working directory
(`shared/<missionId>/`) and puts you on a `mission/<missionId>` branch. **Do not re-clone the
main project** — just start reading and working in that directory. That directory **is the
project root**: the repo's files sit right there (e.g. `index.html` and `styles.css` at the top
level), NOT under a `sites/<name>/` or `<repo>-main/` subpath. Before editing, list the tree
(`work-status`, or `ls`) and confirm the **real** location of the file you were sent to change.
If a path you were handed doesn't exist, the layout was assumed — find the actual file and edit
THAT; never `mkdir` the assumed path or create a parallel file to make a guess true. Move the
change through the flow with the `workspace-git` tools:
- Inspect: `work-status`, `work-diff`, `work-diff --stat`, `work-log`.
- Commit a verified change: `work-commit "v{YYYY}.{MM}.{DD}.{index}.{subindex}: what changed" --add-all`
  (canonical C-23 message — NOT conventional-commit `feat:`/`fix:` prefixes).
- Publish it: `work-sync <repoId> --branch mission/<missionId>`.
- The daemon **merges** your mission branch on completion — you do not merge by hand unless
  asked. Never commit to `main` directly. Read the `workspace-git` skill for the tool details.

When a step needs real logic (a data transform, a scripted check), write a small script to a
temp path and run it, rather than a fragile one-liner — inspect it before you run anything that
mutates state.

## Procedures

### Implement a change in a repo (the full loop)
1. **Read** the manifest/README and map the structure; identify build/test/run commands (or
   note there are none). Read the existing code nearest to your change.
2. **Locate** the exact files/functions to edit; trace the current behaviour.
3. **Implement** the smallest idiomatic change, wired end-to-end.
4. **Verify locally**: install deps → build → test → run/serve and observe the change. Fix and
   re-run until clean.
5. **Self-review** the diff (`work-diff`): confirm the file(s) you intended to change actually
   show your change — if the real target file isn't in the diff, you edited the wrong path; fix
   it. Only intended files, no stray files/leftovers/secrets — and **no stray content**: a hunk
   that adds or removes anything OUTSIDE your intended edit (a stray `}`/quote/tag, a truncated
   region, reformatted lines) is a defect, not cosmetic — reduce the diff to exactly the change.
6. **Commit** (`work-commit` with a C-23 message, `--add-all`) and **sync** (`work-sync`).
7. **Report** what changed, how you verified it (the commands you ran and what they showed), and
   the commit sha.

### Verify locally, by what the project is
Detect first, then use the project's own commands:
- **Has a package manager / build** (Node, Python, Go, Rust, …): install deps with its manager,
  run its build, run its tests, then run the app (dev server, CLI, or entry point) and confirm
  the behaviour. Example shape (read the real scripts, don't assume names): `npm install` →
  `npm run build` → `npm test` → `npm run dev` then fetch the URL.
- **Static site (HTML/CSS/JS, no build step)**: there is nothing to compile — but **reading the
  file back is NOT sufficient verification**. A syntax slip (an unclosed `<style>`/`<script>`, a
  broken inline `<script>`, a stray character, a truncated block) leaves the *source* reading
  fine while the *page* renders blank or mangled — the exact class of bug that keeps shipping to
  a live site. Verify the RENDER, not the text:
  1. **Structural check (fast, deterministic).** The tag structure must be intact: `<style>` vs
     `</style>` counts match, `<script>` vs `</script>` counts match, and `<!doctype>` /
     `<head>` / `</head>` / `<body>` / `</body>` are all present and in order. A truncating or
     quote-"fixing" edit fails this immediately — an unclosed `<style>` swallows the entire body
     as CSS text, so the page renders blank.
  2. **Render check (mandatory for an HTML/CSS change).** Load the page in a **headless browser**
     and read the *rendered* DOM (not the source): confirm `<body>` has content (non-empty), your
     change is visible in the rendered output, and no other section blanked or shows stray markup.
     If a headless **screenshot/render tool** is available (e.g. a `*-render` tool), render the
     page and LOOK — a stray character (`}`), a broken section, or a blank fold is obvious in the
     render and invisible in a read-back. Only a passing render proves an HTML edit. To exercise
     JS behaviour, serve on a **free/ephemeral port** (`python3 -m http.server 0` — read the port
     it prints; never assume `:8000`/`:3000` is free, a stale server there churns on "Address
     already in use"), fetch, then stop the server.
  3. **Assets & paths.** Confirm CSS/link/asset references are correct relative paths.
- **A library or a subcommand**: exercise it — run the relevant test, or a tiny script that
  imports/calls the changed code and prints the result.
If you genuinely cannot run it in this environment, say exactly why and verify as far as you
can (build/lint/parse), rather than claiming success you did not observe.

### Translate a design into code
When handed a design, mockup, or spec (e.g. from a designer):
1. Read the design AND the project's **design system / existing components** — you implement in
   the project's tokens and patterns, not a parallel style.
2. Find where similar UI already lives; build the new piece the same way (same components,
   same CSS variables/classes, same file conventions).
3. Implement structure + styles + any behaviour together; wire real content/data, not lorem.
4. Verify it renders and matches the intent; check it did not disturb the rest of the page.
5. Commit + sync.

## Error Recovery
| Symptom | Likely cause | Recovery |
|---|---|---|
| Build fails after your change | A real error your change introduced (or a pre-existing break) | Read the full error — it names file+line. Fix the cause; re-run the build. If it failed *before* your change too, say so and scope your work to what you can verify. |
| `command not found` for the build/test | You guessed the command instead of reading the manifest | Open `package.json` scripts / the README and use the project's real command. |
| Dependencies missing / import errors | Deps not installed for this checkout | Install with the project's own manager (`npm install`, `pip install -r …`, `go mod download`, …), then re-run. |
| "Address already in use" / the serve step hangs or keeps retrying on a port | You bound a fixed common port (`:8000`/`:3000`) a stale server already holds | Bind an ephemeral port (`python3 -m http.server 0`, then read the port it prints) or a high random one, fetch, assert, then stop the server. For a static change, skip the server entirely and assert the change by reading the file back. Don't retry the same busy port. |
| A test fails | Your change broke behaviour — or the test encodes an assumption your change intentionally changed | Default: fix the code, not the test. Only edit a test if the requirement genuinely changed, and say why. Never delete a test to go green. |
| You edited the wrong file / a generated file | Located by guessing, or edited build output | Revert it (`work-diff` to see, restore from git), re-locate the real source by reading, and redo the change there. |
| `work-diff` shows no change to your target file — or a **new** file (e.g. `home.html`) instead of the existing one (`index.html`) | You edited an invented/parallel file, or only produced the new code as a message instead of writing it into the file | The real file is untouched. Find the file the task names / the app actually serves, edit THAT in place, and re-run `work-diff` until it shows your change in the intended file. Never report done until the diff proves the real file changed. |
| A path you were handed doesn't exist (e.g. `sites/<name>/index.html`) | An assumed nested/monorepo layout — the auto-clone root **is** the project root | List the tree (`work-status`, `ls`); the file is usually at the workspace root. Edit the real file at its actual path. Do NOT create the assumed directory/file to make the guessed path real. |
| Can't tell the stack / how to run it | No obvious manifest | Look wider (Makefile, Dockerfile, CI config, README); if it is plainly static assets, treat it as a static site (no build). Don't invent a toolchain. |
| Repo is full of unrelated files/notes | A noisy or artifact-polluted repo | Identify the actual source (the files the site/app is built from) and ignore the noise; change only real source. |
| Big diff for a small change | Reformatting or an editor rewrote unrelated lines | Reduce the diff to only the intended change; re-run the formatter the project uses (if any), not a different one. |
| A one-word edit produced a huge diff, stray `\'` in the file, or the page renders blank below the fold | You edited by piping a large quoted block through inline `sed` — the shell escaped the apostrophes/quotes into the file | Make the edit surgical: match the smallest unique token, or use `writeFile`/a `python3` `.replace()` (literal, no shell escaping). See system-shell "Edit a file in place — quote trap". Verify `work-diff --stat` is minimal and `grep "\\'"` is empty. |
| The whole page (or everything below a point) renders BLANK though the source "reads fine" | An unclosed `<style>`/`<script>` — often from a truncating or quote-"fixing" edit — swallows the rest of the document as CSS/JS text | Run the structural check: `<style>`==`</style>`, `<script>`==`</script>`, and `</head>`+`<body>` present/ordered. Close the unclosed tag, or **restore the file from the last-good commit** (`git checkout <good-sha> -- <file>`) instead of re-editing corrupted text. NEVER verify an HTML edit by read-back alone — render it and read the rendered body. |
| A stray character (`}`, `{`, a quote, a tag fragment) shows up in the rendered page | An edit added markup OUTSIDE the intended change — a leftover from a template/interpolation or a botched find/replace | The diff self-review must catch it: any change outside your intended edit is a defect. Revert, redo surgically (smallest unique match, literal `.replace()`), then RENDER to confirm the artifact is gone (a read-back won't show it as wrong). |

## Safety
- **Never** write secrets, keys, or tokens into code or commits; read them at runtime via the
  secrets tools if needed.
- Change **source**, never generated/build output or vendored dependencies.
- **Verify before you commit** — a green, observed run is the bar; do not commit a red or
  unverified tree.
- Use the `work-*` tools for git; never `git push`/`gh`/force-push or touch `.git` internals.
- Keep changes scoped to the task; if you discover unrelated problems, report them rather than
  fixing them in the same change.
