<#
.SYNOPSIS
    Test an Architect Prime checkpoint end-to-end on GCP.

.DESCRIPTION
    Creates a fresh VM in architect-prime-beta, runs Phase 2 via startup script,
    polls for completion, runs SSH verification, and optionally tears down.

.PARAMETER CoreRef
    Git ref (branch, tag, or SHA) to test. Default: main

.PARAMETER Action
    What to do: full | create | verify | teardown | status
    - full:     delete old VM -> create -> wait -> verify -> report
    - create:   delete old VM -> create (don't wait/verify)
    - verify:   run verification checks on an existing VM
    - teardown: delete the VM
    - status:   show VM status + serial port tail

.EXAMPLE
    .\test-checkpoint.ps1 -CoreRef "feat/install-sh" -Action full
    .\test-checkpoint.ps1 -Action verify
    .\test-checkpoint.ps1 -Action teardown
#>
param(
    [string]$CoreRef     = "main",
    [string]$ProjectId   = "architect-prime-beta",
    [string]$Zone        = "us-central1-a",
    [string]$VmName      = "architect-prime",
    [string]$SaName      = "architect-prime",
    [string]$Action      = "full",
    [int]$BootWaitSecs   = 30,
    [int]$Phase2TimeoutSecs = 600
)

# ---- Resolve gcloud ----
$gcloudPaths = @(
    "$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd",
    "$env:ProgramFiles\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
)
$gcloud = $null
foreach ($p in $gcloudPaths) {
    if (Test-Path $p) { $gcloud = $p; break }
}
if (-not $gcloud) {
    try { $gcloud = (Get-Command gcloud -ErrorAction Stop).Source } catch {}
}
if (-not $gcloud) { Write-Error "gcloud not found"; exit 1 }

$SaEmail   = "${SaName}@${ProjectId}.iam.gserviceaccount.com"

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host " Architect Prime - Checkpoint Test" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Action   : $Action"
Write-Host "  CoreRef  : $CoreRef"
Write-Host "  Project  : $ProjectId"
Write-Host "  Zone     : $Zone"
Write-Host "  VM       : $VmName"
Write-Host "  SA       : $SaEmail"
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# ---- Helper: run gcloud, return output string and exit code ----
function Invoke-Gcloud {
    param([string[]]$GcloudArgs)
    $allOutput = & $gcloud @GcloudArgs 2>&1
    $code = $LASTEXITCODE
    $text = ($allOutput | Out-String).Trim()
    return @{ Output = $text; ExitCode = $code }
}

# ---- Helper: run short SSH command on the VM ----
function Invoke-SshCmd {
    param([string]$RemoteCmd)
    $r = Invoke-Gcloud @("compute", "ssh", $VmName, "--zone=$Zone", "--project=$ProjectId", "--quiet", "--command=$RemoteCmd")
    # Filter out SSH warnings
    $lines = $r.Output -split "`n" | Where-Object {
        ($_ -notmatch "^WARNING:") -and ($_ -notmatch "^Access granted") -and ($_.Trim() -ne "")
    }
    return @{ Output = ($lines -join "`n"); ExitCode = $r.ExitCode }
}

# ---- Generate startup script as a temp file ----
function New-StartupScript {
    $lines = @(
        '#!/usr/bin/env bash'
        'set -euo pipefail'
        'LOG_FILE="/var/log/architect-prime-phase2.log"'
        'exec > >(tee -a "$LOG_FILE") 2>&1'
        ''
        'echo "========== PHASE 2 STARTUP BEGIN =========="'
        "echo `"CoreRef: ${CoreRef}`""
        "echo `"Project: ${ProjectId}`""
        'echo "Time:    $(date -Is)"'
        ''
        "export GH_OWNER='Tachin-ai-Corporation'"
        "export GH_REPO='architect-prime-gcp-agent'"
        "export CORE_REF='${CoreRef}'"
        "export GCP_PROJECT_ID='${ProjectId}'"
        "export EXPECTED_RUNTIME_SA_EMAIL='${SaEmail}'"
        "export OPENCLAW_PIN_SHA=''"
        ''
        'CORE_BASE="https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${CORE_REF}"'
        'curl -fsSL "${CORE_BASE}/bootstrap/phase2-vm.sh" | bash'
        ''
        'echo "========== PHASE 2 STARTUP COMPLETE =========="'
    )

    $tmpFile = Join-Path $env:TEMP "architect-prime-startup.sh"
    # Write with LF line endings
    $content = $lines -join "`n"
    [System.IO.File]::WriteAllText($tmpFile, $content + "`n")
    return $tmpFile
}

# ---- ACTION: teardown ----
function Invoke-Teardown {
    Write-Host "==> Deleting VM '$VmName'..." -ForegroundColor Yellow
    $r = Invoke-Gcloud @("compute", "instances", "delete", $VmName, "--zone=$Zone", "--project=$ProjectId", "--quiet")
    if ($r.ExitCode -eq 0) {
        Write-Host "    VM deleted." -ForegroundColor Green
    } else {
        Write-Host "    VM not found or already deleted." -ForegroundColor DarkGray
    }
}

# ---- ACTION: create ----
function Invoke-Create {
    # Delete old VM
    Write-Host "==> Removing existing VM (if any)..." -ForegroundColor Yellow
    Invoke-Gcloud @("compute", "instances", "delete", $VmName, "--zone=$Zone", "--project=$ProjectId", "--quiet") | Out-Null
    Start-Sleep -Seconds 5

    # Generate startup script
    Write-Host "==> Generating startup script for CoreRef=$CoreRef..." -ForegroundColor Cyan
    $startupScript = New-StartupScript
    Write-Host "    Written to: $startupScript"

    # Create VM
    Write-Host "==> Creating VM '$VmName'..." -ForegroundColor Cyan
    $createArgs = @(
        "compute", "instances", "create", $VmName,
        "--zone=$Zone",
        "--project=$ProjectId",
        "--image-family=ubuntu-2204-lts",
        "--image-project=ubuntu-os-cloud",
        "--machine-type=e2-standard-2",
        "--boot-disk-size=200GB",
        "--service-account=$SaEmail",
        "--scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/chat.bot",
        "--tags=allow-https",
        "--labels=app=architect-prime,role=prime,env=beta,managed=bootstrap",
        "--metadata=architect_prime=true,role=prime,env=beta",
        "--metadata-from-file=startup-script=$startupScript"
    )
    $r = Invoke-Gcloud $createArgs

    if ($r.ExitCode -ne 0 -and $r.Output -notmatch "Created") {
        Write-Host "Failed to create VM:" -ForegroundColor Red
        Write-Host $r.Output
        exit 1
    }
    Write-Host "    VM created." -ForegroundColor Green

    # Clean up temp file
    Remove-Item $startupScript -ErrorAction SilentlyContinue
    return $true
}

# ---- ACTION: wait for Phase 2 ----
function Wait-ForPhase2 {
    Write-Host "==> Waiting ${BootWaitSecs}s for VM boot..." -ForegroundColor Cyan
    Start-Sleep -Seconds $BootWaitSecs

    $deadline = (Get-Date).AddSeconds($Phase2TimeoutSecs)
    $found = $false
    $lastLen = 0

    Write-Host "==> Polling serial port for Phase 2 completion (timeout: ${Phase2TimeoutSecs}s)..." -ForegroundColor Cyan
    while ((Get-Date) -lt $deadline) {
        $r = Invoke-Gcloud @(
            "compute", "instances", "get-serial-port-output", $VmName,
            "--zone=$Zone", "--project=$ProjectId", "--start=0"
        )
        $serial = $r.Output

        # Show new output since last poll
        if ($serial.Length -gt $lastLen) {
            $newChunk = $serial.Substring($lastLen)
            $newChunk -split "`n" | Where-Object {
                $_ -match "(==>|ERROR|PHASE 2|Install complete|CoreKit|docker|STARTUP|Installed \d+ files)"
            } | ForEach-Object { Write-Host "    [serial] $_" -ForegroundColor DarkGray }
            $lastLen = $serial.Length
        }

        if ($serial -match "PHASE 2 STARTUP COMPLETE") {
            $found = $true
            break
        }
        if ($serial -match "\[ERROR\].*Line \d+ failed") {
            Write-Host "    ERROR detected in Phase 2!" -ForegroundColor Red
            $serial -split "`n" | Where-Object { $_ -match "ERROR" } | ForEach-Object {
                Write-Host "    $_" -ForegroundColor Red
            }
            return $false
        }
        Start-Sleep -Seconds 15
    }

    if ($found) {
        Write-Host "    Phase 2 completed successfully." -ForegroundColor Green
        return $true
    } else {
        Write-Host "    TIMEOUT waiting for Phase 2 completion." -ForegroundColor Red
        return $false
    }
}

# ---- ACTION: verify ----
function Invoke-Verify {
    Write-Host ""
    Write-Host "==> Running verification checks..." -ForegroundColor Cyan

    $checks = @(
        @{ Name = "Docker running";       Cmd = "sudo docker ps --format 'table {{.Names}}\t{{.Status}}'" },
        @{ Name = "OpenClaw container";    Cmd = "sudo docker ps --filter name=openclaw-gateway --format '{{.Status}}'" },
        @{ Name = "STATE.json exists";     Cmd = "sudo head -5 /opt/openclaw/.openclaw/corekit/STATE.json" },
        @{ Name = "STATE.json coreRef";    Cmd = "sudo grep coreRef /opt/openclaw/.openclaw/corekit/STATE.json" },
        @{ Name = "SOUL.md exists";        Cmd = "sudo ls -la /opt/openclaw/.openclaw/workspace/SOUL.md" },
        @{ Name = "oc wrapper executable"; Cmd = "sudo ls -la /opt/openclaw/.openclaw/bin/oc" },
        @{ Name = "Gateway responding";    Cmd = "sudo docker exec openclaw-gateway curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18789/" }
    )

    $passed = 0
    $failed = 0

    foreach ($check in $checks) {
        $r = Invoke-SshCmd -RemoteCmd $check.Cmd
        $output = $r.Output.Trim()

        if ($r.ExitCode -eq 0 -and $output -ne "") {
            Write-Host "    [PASS] $($check.Name)" -ForegroundColor Green
            Write-Host "           $output" -ForegroundColor DarkGray
            $passed++
        } else {
            Write-Host "    [FAIL] $($check.Name)" -ForegroundColor Red
            if ($output) { Write-Host "           $output" -ForegroundColor DarkGray }
            $failed++
        }
    }

    Write-Host ""
    Write-Host "============================================" -ForegroundColor Cyan
    if ($failed -eq 0) {
        Write-Host "  Results: $passed passed, $failed failed" -ForegroundColor Green
    } else {
        Write-Host "  Results: $passed passed, $failed failed" -ForegroundColor Red
    }
    Write-Host "============================================" -ForegroundColor Cyan

    return ($failed -eq 0)
}

# ---- ACTION: show status ----
function Show-Status {
    Write-Host "==> VM Status..." -ForegroundColor Cyan
    $r = Invoke-Gcloud @(
        "compute", "instances", "list",
        "--project=$ProjectId",
        "--filter=name=$VmName",
        "--format=table(name,zone,status,networkInterfaces[0].accessConfigs[0].natIP)"
    )
    Write-Host $r.Output

    Write-Host ""
    Write-Host "==> Serial port tail (last 30 lines)..." -ForegroundColor Cyan
    $r = Invoke-Gcloud @(
        "compute", "instances", "get-serial-port-output", $VmName,
        "--zone=$Zone", "--project=$ProjectId", "--start=0"
    )
    $lines = $r.Output -split "`n"
    $tail = $lines | Select-Object -Last 30
    $tail | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
}

# ---- Dispatch ----
switch ($Action.ToLower()) {
    "full" {
        Invoke-Gcloud @("config", "set", "project", $ProjectId) | Out-Null
        Invoke-Create
        $phase2Ok = Wait-ForPhase2
        if ($phase2Ok) {
            $verifyOk = Invoke-Verify
            Write-Host ""
            if ($verifyOk) {
                Write-Host "============================================" -ForegroundColor Green
                Write-Host "  CHECKPOINT TEST PASSED" -ForegroundColor Green
                Write-Host "  CoreRef: $CoreRef" -ForegroundColor Green
                Write-Host "============================================" -ForegroundColor Green
                exit 0
            } else {
                Write-Host "  CHECKPOINT TEST FAILED (verification)" -ForegroundColor Red
                exit 1
            }
        } else {
            Write-Host "  CHECKPOINT TEST FAILED (phase 2)" -ForegroundColor Red
            exit 1
        }
    }
    "create" {
        Invoke-Gcloud @("config", "set", "project", $ProjectId) | Out-Null
        Invoke-Create
    }
    "verify" {
        Invoke-Verify
    }
    "teardown" {
        Invoke-Teardown
    }
    "status" {
        Show-Status
    }
    default {
        Write-Error "Unknown action: $Action. Use: full | create | verify | teardown | status"
        exit 1
    }
}
