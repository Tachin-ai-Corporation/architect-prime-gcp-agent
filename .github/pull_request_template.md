## Summary

<!-- What does this PR do and why? -->

## Scope

<!-- 
  Glob patterns defining the allowed change surface.
  CI scope-check will fail if files outside these globs are modified.
  Use one pattern per line.
-->

```
Scope:

```

## Test Evidence

<!-- 
  Mission IDs, CI run links, or test-agent evidence.
  For agent-authored PRs: include the mission IDs from the test agent.
-->

## Checklist

- [ ] `validate-contracts --repo` passes
- [ ] All manifest paths resolve (`test/manifest-integrity.test.mjs`)
- [ ] `node --check` passes on all `.mjs` files
- [ ] `node --test test/` passes
- [ ] No secrets, credentials, or API keys in code, config, or commit history
- [ ] Changes stay within declared Scope globs
