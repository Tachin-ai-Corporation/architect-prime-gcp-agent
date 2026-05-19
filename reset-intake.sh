#!/bin/bash
# Reset stuck intake to pending
curl -s -X PATCH \
  "https://firestore.googleapis.com/v1/projects/architect-prime-beta/databases/(default)/documents/intake/i-1779163173200-vnqvp9?updateMask.fieldPaths=status" \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  -d '{"fields":{"status":{"stringValue":"pending"}}}'
echo ""
echo "Done"
