# E2E Test Workflow

## How It Works

Agent writes code via file edits. User runs commands. Agent monitors via gcloud.

## Quick Commands

### 1. Branch + Commit + Push
```powershell
cd c:\Users\stoph\Antigravity\architect-prime
git checkout -b feat/<name>
git add -A
git commit -m "<message>"
git push origin feat/<name>
```

### 2. Full GCP Test
```powershell
.\test-checkpoint.ps1 -CoreRef "feat/<name>" -Action "full" -Phase2TimeoutSecs 900
```

### 3. Verify Only (reuse running VM)
```powershell
.\test-checkpoint.ps1 -CoreRef "feat/<name>" -Action "verify"
```

### 4. Merge + Tag
```powershell
git checkout main
git merge --squash feat/<name>
git commit -m "v0.X.0: <description>"
git tag -a v0.X.0 -m "v0.X.0: <description>"
git push origin main --tags
```

## Notes
- Agent monitors serial logs via `gcloud compute instances get-serial-port-output`
- Agent runs `verify` action after Phase 2 completes
- If Phase 2 times out, user runs verify manually
