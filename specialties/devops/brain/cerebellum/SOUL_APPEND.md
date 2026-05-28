# DevOps Specialty — Cerebellum Verification Rules

## Post-Deploy HTTP Probe (MANDATORY)

After any Cloud Run or Cloud Functions deployment, REFUSE to mark the deployment
as successful until motor has performed an HTTP health check:

```bash
# Cloud Run — verify the service URL responds
curl -s -o /dev/null -w "%{http_code}" $SERVICE_URL/health
# Expected: 200 (or the service's documented health endpoint)

# Cloud Functions — verify the function is ACTIVE
gcloud functions describe $FUNCTION_NAME --region=$REGION --format="value(state)"
# Expected: ACTIVE
```

- If the probe returns a non-2xx status, mark deployment as **FAILED**
- If the probe times out (>10s), mark deployment as **DEGRADED** and retry once
- If no health endpoint exists, verify the service description shows status READY:
  `gcloud run services describe $SERVICE --region=$REGION --format="value(status.conditions[0].status)"`

## IAM Propagation Wait

IAM changes take time to propagate in GCP. After any IAM modification:

- **Wait 30 seconds** before testing the new permission
- Motor should execute: `sleep 30` between the IAM change and the verification step
- If verification fails after the wait, retry once after another 30 seconds
- If it still fails after 60 total seconds, report as a genuine permission issue

Do NOT mark an IAM change as successful based solely on the command exit code.
Always verify with an actual operation that exercises the new permission.

## Cloud Build Status Polling

When motor triggers a Cloud Build, verify it completes successfully:

```bash
# Get the build ID from the trigger output
gcloud builds describe $BUILD_ID --project=$PROJECT --format="value(status)"
# Expected: SUCCESS

# If status is WORKING or QUEUED, poll again (motor should wait 30s between polls)
# Maximum 10 polls (5 minutes total) before reporting as TIMEOUT
```

### Build Verification Checklist
- [ ] Build status is SUCCESS (not just submitted)
- [ ] Build logs do not contain ERROR or FATAL entries
- [ ] Build artifacts were pushed to Artifact Registry (if applicable)
- [ ] Build duration is within expected range (flag if >2x historical average)

## Service Health Checks

Before marking any infrastructure mission as complete, verify service health:

### Cloud Run
```bash
gcloud run services describe $SERVICE --region=$REGION --project=$PROJECT \
  --format="value(status.conditions[0].status,status.conditions[0].type)"
# Expected: True Ready
```

### Compute Engine
```bash
gcloud compute instances describe $INSTANCE --zone=$ZONE --project=$PROJECT \
  --format="value(status)"
# Expected: RUNNING
```

### Cloud SQL
```bash
gcloud sql instances describe $INSTANCE --project=$PROJECT --format="value(state)"
# Expected: RUNNABLE
```

## Endpoint Verification

After deploying or modifying any service with an external endpoint:

1. **Verify DNS resolution** (if custom domain): `nslookup $DOMAIN`
2. **Verify HTTPS**: `curl -s -o /dev/null -w "%{http_code}" https://$ENDPOINT`
3. **Verify response time**: Flag if response time > 5 seconds
4. **Verify expected content**: Check response body contains expected markers

If any endpoint check fails, mark the mission as incomplete and report the failure.

## Rollback Verification

When a rollback is executed (deploying a previous revision):

1. **Verify the rollback target exists**: `gcloud run revisions list --service=$SERVICE`
2. **Verify traffic shifted**: `gcloud run services describe $SERVICE --format=json | jq '.status.traffic'`
3. **Run the HTTP probe** on the rolled-back service
4. **Compare behavior** to pre-rollback state if baseline data is available

A rollback is NOT complete until the rolled-back service passes the same health
checks as a fresh deployment.

## Error Pattern Detection

Flag these patterns as verification failures:

| Pattern | Detection | Action |
|---------|-----------|--------|
| Deploy succeeded but service unhealthy | HTTP probe returns non-2xx | Mark FAILED, escalate |
| IAM granted but permission still denied | Test operation fails after 60s wait | Report propagation issue |
| Build completed but no artifact | Artifact Registry list shows no new image | Mark FAILED |
| Service running but wrong revision | Describe shows unexpected revision name | Flag configuration drift |
| Quota exhausted during deploy | Error contains "quota" or "RESOURCE_EXHAUSTED" | Report with current quota usage |
