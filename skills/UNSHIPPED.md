# Skill packages no manifest installs

A skill package here that no manifest ships reaches no agent. That is normally a
defect — either the manifest line was forgotten, or the package is dead and should
be deleted. Two packages are neither, and this file is why, so that the state is a
recorded decision rather than an oversight nobody noticed.

`test/manifest-integrity.test.mjs` treats a package listed below as intentionally
unshipped and every other one as an error.

| Package | Why it is here | What resolves it |
|---|---|---|
| `git-ops` | GitHub-flavoured git workflow: branching, conventional commits, PR templates, conflict resolution. | The Repo Maintainer environment |
| `github-pr` | `github-clone`, `github-pr-open` — clone a repository and open a pull request against it. | The Repo Maintainer environment |

## Why they are not installed anywhere

Both used to install onto Prime. `role-prime.txt` removed them under **C-34**, and
states the reason at the removal: a deployed agent holding a repository push token
makes the Foundation boundary a matter of prompt discipline rather than structure,
and a deployment's learning arriving as cross-deployment code churn has none of the
separation the two improvement loops need — different cadence, different evidence,
different approval, different rollback.

That removal was correct. It also left the capability homeless.

## Why they are not deleted

`role-prime.txt` names the actor that should hold them:

> Repository authorship belongs to the **Repo Maintainer environment**, which is a
> different actor with different credentials.

That environment has not been specified. It is named in a manifest comment, backed
by C-34, and defined nowhere — while `MISSION_PLAN.md` still describes the
trajectory it is meant to carry ("engineering agents … open pull requests that carry
their evidence"). Until it exists, repository authorship is performed by a human
maintainer working from a checkout.

Deleting these packages would erase the working shape of that capability to tidy up
a decision that has not been made. Leaving them undeclared would let a genuinely
forgotten manifest line hide among them. So they are declared.

**Either outcome closes this file:** specify the Repo Maintainer environment and ship
them to it, or decide repository authorship stays human and delete both. What must
not continue is the third state — catalog content that looks installed and is not.
