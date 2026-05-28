# Security Specialty — Cerebellum Verification Rules

## Finding Evidence Gate (MANDATORY)

REFUSE to mark any finding as complete unless ALL of the following are present:

- **Raw evidence**: Exact command output from motor (not paraphrased)
- **Timestamp**: When the evidence was collected (from motor execution)
- **Severity rating**: Must match one of: Critical / High / Medium / Low / Informational
- **Resource identifier**: Specific project, SA, bucket, or resource name
- **Recommendation**: At least one actionable remediation step

If ANY field is missing, return the finding to cortex with:
"Verification failed: finding missing [FIELD]. Collect evidence before publishing."

## Severity vs Evidence Strength Validation

Cross-check that the evidence actually supports the assigned severity:

| Severity | Minimum Evidence Required |
|----------|--------------------------|
| Critical | Confirmed exploitable condition with public exposure — must show `allUsers`/`allAuthenticatedUsers` binding OR `0.0.0.0/0` firewall rule with sensitive port OR public bucket with data |
| High | Verified policy violation — must show specific IAM binding, SA key age, or misconfiguration with exact values |
| Medium | Configuration drift from best practice — must show current vs expected state |
| Low | Minor deviation — must show specific resource and current configuration |
| Informational | Observation only — must show at least one relevant command output |

### Reject Severity Inflation
- A finding with no proof of public exposure cannot be Critical
- A finding based on naming conventions alone (no actual policy check) cannot be High
- A stale SA key without evidence of the key's actual age cannot be rated
- Downgrade and return to cortex: "Evidence insufficient for [SEVERITY] rating. Strongest supported rating: [LOWER_RATING]. Reason: [EXPLANATION]"

## Read-Only Compliance Check

Verify that motor did NOT execute any write operations during the mission:

- Scan motor output for forbidden patterns: `add-iam-policy-binding`, `remove-iam-policy-binding`, `set-iam-policy`, `create`, `delete`, `update`, `enable`, `disable`
- If motor executed a write command, flag as a **compliance violation**:
  "COMPLIANCE ALERT: Motor executed write operation [COMMAND] during read-only audit. This finding set may be tainted."

## Known Exceptions Cross-Reference

Before publishing findings, check against known exceptions in MEMORY.md:

- **Approved external principals**: Some external users may have legitimate access
- **Intentionally public resources**: Some buckets or services are designed to be public
- **Legacy service accounts**: Some SAs with broad roles may be awaiting migration
- **Accepted risks**: Some findings may have been previously reviewed and accepted

If a finding matches a known exception:
- Do NOT suppress the finding entirely
- Add annotation: "Known exception — see MEMORY.md [section]. Last reviewed: [DATE]"
- If the exception is older than 90 days, flag for re-review

## Diff Validation

When verifying IAM diff findings (r-security-iam-diff):

- Confirm that both "before" and "after" states are present
- Verify the diff shows actual changes, not just formatting differences
- Validate that flagged new principals are genuinely new (not just reordered output)
- Check that the comparison baseline is from the previous run, not fabricated

## Completeness Checks

Before marking a security audit mission as complete:

1. **All projects in scope were scanned** — verify project list matches expected scope
2. **All finding types were assessed** — IAM, network, SA keys, public surface (as applicable)
3. **No motor errors were silently ignored** — every error must be noted or retried
4. **Recommendations are actionable** — each has an exact command, not vague advice
5. **Owner is assigned** — every finding has a clear responsible party
