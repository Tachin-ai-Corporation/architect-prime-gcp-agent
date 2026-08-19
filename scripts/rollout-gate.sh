#!/usr/bin/env bash
# rollout-gate.sh <expected-ref-prefix>
#
# Runs ON an agent VM after an upgrade. Every check prints PASS/FAIL and the
# script exits non-zero on the first FAIL, so a caller rolling the fleet stops
# rather than continuing onto the next agent.
#
# T3 (throwaway-agent proof of each job manifest) was skipped, so this gate is
# the only thing standing between an untested job manifest and a production
# agent. It checks more than health: health is what a broken install looks like
# for the first few minutes.
set -uo pipefail
EXPECT="${1:?usage: rollout-gate.sh <expected-ref-prefix>}"
R=/opt/corekit
fails=0
chk() { # chk <label> <condition-result> <detail>
  if [[ "$2" == "0" ]]; then printf '  PASS  %-34s %s\n' "$1" "${3:-}"
  else printf '  FAIL  %-34s %s\n' "$1" "${3:-}"; fails=$((fails+1)); fi
}

# 1. The ref that is installed is the ref we asked for.
REF=$(sudo grep -o '"coreRef": *"[^"]*"' "$R/corekit/STATE.json" 2>/dev/null | head -1 | sed 's/.*: *"//;s/"//')
[[ "$REF" == "$EXPECT"* ]]; chk "installed ref" $? "${REF:0:12} (wanted ${EXPECT:0:12})"

# 2. The pre-move layout is gone.
#
#    This used to check four directories — corekit/lib, corekit/daemon,
#    corekit/contracts and brain — and report all four absent, which read as
#    strong evidence. Three of them were VACUOUS: at the old ref
#    `corekit/daemon/*` installed to `bin/*.mjs` and `brain/*` to
#    `agents/`/`workspace-*`, so those DIRECTORIES never existed on any VM,
#    before or after. They could not fail. Only corekit/lib is both a repo path
#    and a VM path, so only it was ever a check. Caught by rolling an agent BACK
#    and seeing "absent" for three trees that had just been reinstalled.
#
#    A leftover corekit/lib is not inert: it is a second copy of the modules that
#    a stray relative import can still resolve against.
[[ ! -d "$R/corekit/lib" ]]; chk "corekit/lib removed" $? "$(sudo find "$R/corekit/lib" -type f 2>/dev/null | wc -l) files"
[[ ! -e "$R/lib" ]]; chk "lib symlink gone" $?

#    Replaces the vacuous daemon-directory check with one that can fail: the
#    launchers in bin/ must point at platform/runtime. If a daemon still execs a
#    bin/*.mjs copy, the move did not reach the thing that actually runs.
NLAUNCH=$(sudo grep -l 'platform/runtime' "$R"/bin/start-agent-* 2>/dev/null | wc -l)
[[ "$NLAUNCH" -ge 4 ]]; chk "launchers exec platform/runtime" $? "$NLAUNCH/4 launchers"
[[ ! -f "$R/bin/agent-brain.mjs" ]]; chk "no stale bin/agent-brain.mjs" $?

# 3. The new layout is present and non-empty.
MISS=""
for d in platform/runtime platform/work platform/persistence platform/contracts platform/security; do
  n=$(sudo find "$R/$d" -type f 2>/dev/null | wc -l)
  [[ "$n" -gt 0 ]] || MISS="$MISS $d"
done
[[ -z "$MISS" ]]; chk "platform packages installed" $? "${MISS:-all present}"

# 4. Every daemon is up. Checked twice, 20s apart: systemd reports `active`
#    between a crash and its restart, so a single sample cannot tell a running
#    daemon from a crash-looping one.
SVC="agent-brain agent-ears agent-mouth agent-introspect agent-neural-gateway"
A1=$(systemctl is-active $SVC 2>/dev/null | grep -c '^active$')
sleep 20
A2=$(systemctl is-active $SVC 2>/dev/null | grep -c '^active$')
NRESTART=$(systemctl show agent-brain -p NRestarts --value 2>/dev/null || echo 0)
[[ "$A1" == "5" && "$A2" == "5" ]]; chk "5/5 services active (2 samples)" $? "$A1 then $A2"

# 5. Contract validation, as the VM itself sees it (C-19).
# Per-run temp file. A fixed name here is owned by whoever ran this gate first,
# and the SHELL opens the redirect target, not sudo — so every later run by
# another user dies with EACCES and the check reports FAIL while its own subject
# printed a clean pass. That is exactly what happened mid-roll on archie: a red
# gate on a healthy agent, which is the most expensive kind of false alarm.
VC_LOG="$(mktemp -t rollout-vc.XXXXXX)"
trap 'rm -f "$VC_LOG"' EXIT
sudo CORE_ROOT="$R" "$R/bin/validate-contracts" --runtime >"$VC_LOG" 2>&1
chk "validate-contracts --runtime" $? "$(tail -1 "$VC_LOG" | cut -c1-70)"

# 6. The brain actually loaded its modules and restarted AFTER this install.
#
#    The window is `installedAt` from STATE.json, not "3 minutes ago". The first
#    version of this check used a fixed window and failed a perfectly healthy
#    agent whose banner was simply older than it — a gate that fails good agents
#    mid-rollout either halts a working rollout or teaches you to ignore it.
#    Anchoring to the install makes the assertion the one actually wanted: the
#    brain came up on THIS content, whenever the gate happens to run.
INST=$(sudo grep -o '"installedAt": *"[^"]*"' "$R/corekit/STATE.json" 2>/dev/null | head -1 | sed 's/.*: *"//;s/"//')
SINCE=$(date -u -d "$INST" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo '30 minutes ago')
ERRS=$(sudo journalctl -u agent-brain --since "$SINCE" --utc --no-pager 2>/dev/null \
  | grep -ciE 'Cannot find module|ERR_MODULE_NOT_FOUND|SyntaxError' || true)
[[ "${ERRS:-0}" -eq 0 ]]; chk "no module-resolution errors" $? "${ERRS:-0} since install"
BOOT=$(sudo journalctl -u agent-brain --since "$SINCE" --utc --no-pager 2>/dev/null \
  | grep -c 'Brain v3 starting' || true)
[[ "${BOOT:-0}" -ge 1 ]]; chk "brain started since install" $? "${BOOT:-0} banner(s) since $SINCE"

# 6b. Not crash-looping. `active` is what systemd reports between a crash and its
#     restart, so steps 4 and 6 can both pass while the process dies in a loop.
#     A climbing NRestarts is the only thing that distinguishes them.
sleep 20
NR2=$(systemctl show agent-brain -p NRestarts --value 2>/dev/null || echo 0)
[[ "${NR2:-0}" -eq "${NRESTART:-0}" ]]; chk "brain not restarting" $? "NRestarts ${NRESTART:-0} -> ${NR2:-0}"

# 7. Skills installed and indexed — the quiet failure mode is an agent that boots
#    healthy with no capabilities.
NSK=$(ls "$R/skills" 2>/dev/null | wc -l)
[[ "$NSK" -ge 10 ]]; chk "skills installed" $? "$NSK packages"

# 8. Motor cannot write Foundation, and CAN still write its workspace.
#
#    Both directions, because either alone is meaningless: a denial that also
#    blocks legitimate work is an outage, and an allowed write proves nothing
#    about the denial.
#
#    Run INSIDE the brain's mount namespace. This is the whole reason the check
#    is shaped this way: ReadOnlyPaths applies to the unit's namespace, not to
#    this SSH shell, so testing from here would report "denied" for a completely
#    unprotected agent — a check that passes without measuring anything.
BRAIN_PID="$(systemctl show agent-brain -p MainPID --value 2>/dev/null || echo 0)"
if [[ "${BRAIN_PID:-0}" -gt 0 ]] && command -v nsenter >/dev/null 2>&1; then
  # Denied: a Foundation path.
  nsenter --target "$BRAIN_PID" --mount -- sh -c 'touch /opt/corekit/platform/.deny-probe' 2>/dev/null
  denied=$?
  nsenter --target "$BRAIN_PID" --mount -- sh -c 'rm -f /opt/corekit/platform/.deny-probe' 2>/dev/null || true
  [[ "$denied" -ne 0 ]]; chk "motor DENIED writing platform/" $? "exit $denied (non-zero = denied)"

  # Allowed: the mission working root. If this fails the sandbox is too tight
  # and every mission breaks.
  nsenter --target "$BRAIN_PID" --mount -- sh -c 'touch /opt/corekit/shared/.allow-probe' 2>/dev/null
  allowed=$?
  nsenter --target "$BRAIN_PID" --mount -- sh -c 'rm -f /opt/corekit/shared/.allow-probe' 2>/dev/null || true
  [[ "$allowed" -eq 0 ]]; chk "motor ALLOWED writing shared/" $? "exit $allowed (zero = allowed)"
else
  # Not skipped silently: an unmeasurable claim is not a passing one.
  chk "motor Foundation deny (namespace probe)" 1 "brain MainPID=${BRAIN_PID:-0}, nsenter present=$(command -v nsenter >/dev/null 2>&1 && echo yes || echo no)"
fi

echo
if [[ $fails -eq 0 ]]; then echo "GATE PASS  ref=${REF:0:12} services=$A2/5 skills=$NSK"; exit 0
else echo "GATE FAIL  ($fails check(s) failed)"; exit 1; fi
