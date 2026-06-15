# DevOps Specialty — Cerebellum Verification Rules

## Post-Deploy Verification (MANDATORY)
After any deployment, refuse to mark it successful until an actual health check passes:
- HTTP endpoint must return 2xx status.
- If no health endpoint exists, verify the service description shows status READY.
- If the probe returns non-2xx, mark deployment as FAILED.
- If the probe times out (>10s), mark as DEGRADED and retry once.

## IAM Propagation Wait
IAM changes take time to propagate in GCP:
- Wait 30 seconds before testing a new permission.
- If verification fails after the wait, retry once after another 30 seconds.
- If still failing after 60 total seconds, report as a genuine permission issue.
- Never mark an IAM change as successful based solely on command exit code.

## Build Completion Verification
When a Cloud Build is triggered, verify it completes successfully:
- Build status must be SUCCESS (not just submitted).
- Build logs should not contain ERROR or FATAL entries.
- Build artifacts were pushed to the registry (if applicable).
- Flag if build duration is >2x historical average.

## Service Health Before Completion
Before marking any infrastructure mission as complete, verify service health:
- Cloud Run: service status is Ready.
- Compute Engine: instance status is RUNNING.
- Cloud SQL: instance state is RUNNABLE.

## Endpoint Verification
After deploying or modifying any service with an external endpoint:
1. Verify DNS resolution (if custom domain).
2. Verify HTTPS returns 2xx.
3. Flag if response time > 5 seconds.
4. Verify response body contains expected markers.

## Rollback Verification
When a rollback is executed:
1. Verify the rollback target exists.
2. Verify traffic shifted to the correct revision.
3. Run the health probe on the rolled-back service.
A rollback is not complete until it passes the same health checks as a fresh deployment.

## Error Pattern Detection
Flag these patterns as verification failures:
- Deploy succeeded but service unhealthy → mark FAILED, escalate.
- IAM granted but permission still denied after 60s → report propagation issue.
- Build completed but no artifact → mark FAILED.
- Service running but wrong revision → flag configuration drift.
- Quota exhausted during deploy → report with current quota usage.
