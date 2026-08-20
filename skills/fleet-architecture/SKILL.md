# Fleet Architecture

How to evolve this deployment's fleet — its roles, souls, skills, playbooks and schedules —
immutably, with evidence, and reversibly. Every change goes through `fleet-config`; nothing
here edits the platform.

## When to use

- The operator asks for a new kind of agent, or asks an existing one to work differently.
- A failure pattern across missions points at a role, soul, skill or playbook rather than a bug.
- A skill's procedure is wrong, incomplete, or missing its error recovery.
- A recurring duty should become a responsibility.
- Something genuinely cannot be done with what the platform exposes — file a Platform Finding.

## The first question: which plane

Ask in order, and stop at the first yes.

1. **Is it a live occurrence, observation or assignment?** Runtime State — read it, do not author it.
2. **Does it define a role, preference, procedure, schedule, playbook or policy, using capabilities
   the platform already exposes?** Fleet Definition — this skill.
3. **Does it change an invariant, schema, state transition, provider, privileged executable, storage
   behavior, security boundary, IAM class or installation behavior?** Foundation — not mine.
   File a Platform Finding.
4. **Would two unrelated deployments reasonably want different values?** Then it must not be
   hard-coded in the platform; it is a definition.
5. **Would the change let a definition acquire power its compiled capability profile does not
   already grant?** Reject it as a definition. Platform Finding.

Getting this wrong in the safe direction (filing a finding for something that was authorable) costs
a round trip. Getting it wrong the other way produces drift nobody can see.

## The lifecycle

```
inspect → draft → validate → evaluate → canary → promote → observe → roll back
```

Never skip validate. Never promote fleet-wide off a canary of one, unless the operator says so.

### Inspect first

```bash
fleet-config status                     # what is active, who is on it, where drift is
fleet-config list role                  # what this deployment defines
fleet-config get role web-master        # one definition with its provenance
fleet-config compile <agent>            # what an agent actually resolves to, and its digest
```

Read the current revision before drafting against it. The revision you read is the `baseRevision`
you must supply; an edit without one is refused, and an edit against a superseded one conflicts
rather than overwriting whoever got there first.

### Draft

A change carries a title, a rationale, and one or more definition edits. The rationale is the first
thing an operator reads on a proposal card — write the *why*, not the *what*; the diff already
shows the what.

```bash
# Author a NEW definition. The body is JSON on stdin; the kind is the argument.
echo '{"id":"legal-review","name":"Legal Review","summary":"...","triggers":["..."],"procedure":"..."}' \
  | fleet-config change create skill --title "Add legal-review" --rationale "why this is needed"

# Edit an existing one, WHOLE-BODY. Same shape; the base revision is resolved for
# you, so a concurrent edit by someone else is caught instead of silently
# overwriting them. Only use this for a SMALL definition you can reproduce exactly.
cat updated-skill.json | fleet-config change update skill --title "Broaden legal-review triggers"

# Edit a LARGE body surgically — the safe way to change a skill's procedure, a
# process's narrative, a responsibility's instruction. You supply only a UNIQUE
# anchor and its replacement; the registry holds the body. The anchor must match
# exactly once or the command refuses (0 = wrong anchor, >1 = ambiguous).
fleet-config change edit skill/workspace-docs \
  --find "the exact sentence to change, copied verbatim" \
  --replace "the corrected sentence" \
  --title "Fix the read-first step" --rationale "why"

# Retire one. This is an EDIT, not a delete — the definition survives so a
# rollback still has something to roll back to.
fleet-config change deprecate skill/legal-review --title "Superseded by contract-review"
```

`create` refuses a definition that already exists and `update` refuses one that does not, so the
verb you pick states your assumption and the command checks it.

**For any large body, use `change edit`, not `change update`.** A skill's `procedure` can be tens of
thousands of characters. `change update` requires you to resubmit the ENTIRE body, and reproducing a
huge body from memory reliably drops most of it — an edit that "improves one step" silently ships a
stub, which then validates and releases because the shape is still valid. `change edit` never puts
the whole body in your hands: you name the one place to change. As a backstop, `change update`
refuses an edit that collapses a substantial body to a fraction of its length (pass `--allow-shrink`
only when a near-total deletion is genuinely intended).

**You never write a definition file yourself.** There is no path where an agent edits the registry
directly: the body goes in on stdin, and the service derives the revision, validates it against the
schema, computes the diff and commits it. If you find yourself reaching for a file write to change
fleet content, you are in the wrong plane — see *The first question* above.

A body that fails schema validation is refused **before** anything is pushed, so a bad draft leaves
no branch and no record behind.

### Validate

```bash
fleet-config validate <changeId>
```

Six checks run and are recorded by name on the change: secret material, reference resolution,
delegation cycles, composed prompt budget, platform compatibility, privilege escalation. An absent
check is not a pass, which is why they are named.

### Diff and impact

```bash
fleet-config diff <changeId>
```

Returns the semantic diff and — the question an operator actually asks before approving — **which
agents this touches**. A skill change reaches every role that assigns it; a playbook reaches
everyone.

### Release, canary, promote

```bash
fleet-config release <changeId>
fleet-config assign <releaseId> --agents millie --role assistant --pin   # canary
fleet-config assign <releaseId> --agents millie,stan,tom --role …        # wider
fleet-config rollback <releaseId> --reason "…"
```

`--pin` holds an agent to a release so a later fleet-wide promotion does not move it. That is what
makes a canary a canary.

Content reaches the agent through `agent-content-sync`, which applies at an **idle mission
boundary** — a definition never changes underneath running work. Expect a few minutes, not
instantly, and `fleet-config status` shows the drift while it converges.

## Designing each kind of definition

**Role.** Purpose, owned outcomes, decision posture, collaboration, escalation. Outcomes are
*results the role is accountable for*, not tasks it performs — "the live site reflects the agreed
content" rather than "runs firebase deploy". Capabilities are derived from the skills the role
holds; do not hand-author them.

**Soul overlay.** Character, values, decision bias, epistemic discipline. Never tool syntax — a
backticked flag in a soul is rejected at seal time, and rightly: the skill is where a command lives.
Overlays add disposition; they cannot reach the wiring.

**Skill.** Triggers that let an organ recognize when it applies, a procedure that drives the tools,
and error recovery. Recovery guidance is what separates a skill from a man page: a symptom, a cause,
and what to do. A skill may only bind capabilities its assigned roles already declare.

**Process.** A narrative of how a recurring kind of work has gone well — prose the agent recalls
into its own plan, never a step list the daemon executes. If it reads as numbered commands, it is a
skill wearing the wrong hat.

**Responsibility.** A trigger, an instruction, and success criteria the agent can judge itself
against. State the timezone; a schedule without one silently shifts.

## Diagnosing from evidence, not anecdote

Before changing anything, ground it:

- mission trees and where they actually stalled;
- repeated tool errors, and whether the tool or the instruction was wrong;
- `needs_input` and blocked rates — an agent asking too often has an unclear boundary, not a
  character flaw;
- false-completes — the agent believed it succeeded, which is a verification problem;
- iteration counts and cost;
- operator corrections, which are the highest-signal evidence there is.

**Do not overfit.** One failure is an anecdote. Two failures with the same shape are a pattern. A
change written to make one transcript come out right usually makes the next one worse. Write the
rule you would have wanted *before* seeing this failure, and check it against a second case.

Never rewrite an agent's identity from a single bad run.

## Evaluation

An eval suite names cases, what a pass observably looks like, and thresholds. A case asserts the
**outcome** — "the staging URL returns 200 and serves the updated page" — never an incidental tool
detail like which auth flag was used or whether a deprecation warning appeared. Runtime noise is not
the deliverable.

Baseline and candidate run under the same platform version, the same model, and the same fixtures.
Changing the model and the content at once means neither can be blamed.

Human corrections become regression cases. They do not become automatic prompt edits.

## Platform Findings — the only way out

When the answer genuinely requires a new provider, permission class, schema, state transition or
runtime mechanism:

```bash
fleet-config finding create \
  --title "Support role needs read access to the ticketing system" \
  --class provider \
  --severity medium \
  --frequency "every support mission, ~12 per week" \
  --missions m-abc,m-def \
  --invariant "An agent can read tickets without a human pasting them by hand." \
  --why-not "No approved provider exposes the ticket API. A skill can only bind capabilities that already exist, so this cannot be a definition." \
  --workaround "Operator pastes ticket text into the mission" \
  --workaround-limits "Manual, delays first response, and the agent cannot see attachments"
```

Write the **desired invariant**, not a demanded implementation — maintainers design the fix, and a
finding that dictates one usually gets the design wrong. `--why-not` is not paperwork: a finding that
could have been a definition is drift with extra steps.

The finding text is scanned before filing; a finding leaves the deployment, so it does not leave
unsanitized.

Then say so plainly, and deliver the part that *is* possible. A role whose connector does not exist
yet can still be drafted, validated and canaried for everything else it does.

## Explaining a change to the operator

Lead with the answer. Then, briefly:

- **what changed**, in agent terms — "web-master now deploys through a preview channel first";
- **why**, with the evidence;
- **who it touches**, from the impact analysis;
- **what the risk is**, honestly;
- **how to undo it** — the rollback target, by id.

A proposal an operator cannot undo in one command is not ready.

## What this skill never does

- Edit the platform, its installed files, or its security boundaries.
- Open a pull request against the product repository.
- Grant a capability, widen egress, or inject a secret — the compiler refuses all three.
- Promote fleet-wide without evidence, or roll back without saying why.
