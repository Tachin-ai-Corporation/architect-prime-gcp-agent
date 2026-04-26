# Self-Maintenance

After completing work that changes project architecture, conventions, paths, or tooling:

1. **Check `.agents/rules/`** — Update `project-context.md` and `coding-standards.md` if the change affects project structure, versioning, VM paths, coding patterns, or development workflow.
2. **Check `.agents/workflows/`** — Update any affected workflows if CLI syntax, zone, VM names, or procedures changed.
3. **Keep it current** — These files are loaded every turn. Stale context wastes time and causes errors. If you learned something new (a gotcha, a correct CLI format, a path fix), encode it here.
