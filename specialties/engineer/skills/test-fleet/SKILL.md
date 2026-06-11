# Fleet Test Missions

Canned test missions for validating a test agent during `p-implement-verify`. These missions are versioned — do not improvise per run.

## Usage

During CP4 of `p-implement-verify`, send these three missions to the test agent via GChat DM. Wait for each to complete before sending the next.

## Mission 1 — Simple Q&A

### Message to send:
```
What version of Node.js are you running? Reply with the output of `node --version`.
```

### Expected signals:
- [ ] Mission created in `work` collection within 2 minutes
- [ ] Mission status transitions: `pending` → `active` → `complete`
- [ ] Output contains a Node.js version string (e.g., `v20.x.x`)
- [ ] No errors in task logs

### Verification:
```bash
work-log-read --agent <test-agent> --status complete --limit 1
```

---

## Mission 2 — Process Execution

### Message to send:
```
Run the p-investigate process on this topic: "How does the agent-ears daemon detect new messages?" Report your findings.
```

### Expected signals:
- [ ] Mission created with `processRef: p-investigate`
- [ ] At least first checkpoint (CP1: frame question) completes
- [ ] Motor dispatched for research-intent steps
- [ ] Output contains structured investigation findings
- [ ] No process-loading errors in brain logs

### Verification:
```bash
work-log-read --agent <test-agent> --status complete --limit 1
task-log-read --agent <test-agent> --limit 5
```

---

## Mission 3 — Memory Round-Trip

### Message to send:
```
Write the following fact to Core Memory under category "test": "Canned test mission executed successfully on <today's date>". Then immediately read it back and confirm it was stored.
```

### Expected signals:
- [ ] Motor calls `core-memory-write` with the test fact
- [ ] Motor calls `core-memory-read` and retrieves the fact
- [ ] Output confirms the write/read round-trip succeeded
- [ ] Fact appears in Firestore `core_memory` collection
- [ ] No auth errors (validates DWD and Firestore access)

### Verification:
```bash
work-log-read --agent <test-agent> --status complete --limit 1
```

---

## Failure Handling

If any mission fails:
1. Check brain logs: `journalctl -u agent-brain --since "5 min ago"` (via fleet-status or SSH)
2. Check ears logs: `journalctl -u agent-ears --since "5 min ago"`
3. Fix the code on the feature branch
4. Push and re-upgrade: `fleet-upgrade <test-agent> --ref <branch>`
5. Re-send the failed mission
6. Maximum 3 retry iterations, then report `blocked`

## Pass Criteria

All 3 missions must reach `status: complete` with expected outputs. Evidence (mission IDs from `work-log-read`) must be included in the PR description.
