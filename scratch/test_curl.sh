#!/usr/bin/env bash
TOKEN=$(AGENT_USER_EMAIL=assistant-agent-millie@tachin.ag /opt/corekit/bin/ws-token --scope docs)
rm -f /tmp/docs-response-test.json
HTTP_CODE=$(curl -s -o /tmp/docs-response-test.json -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "https://docs.googleapis.com/v1/documents/1K1qmGve-zgKlpRBNSncvp7yeypiZ1AzgnqD11ggMsHk")
echo "HTTP Code: $HTTP_CODE"
echo "Response Body:"
cat /tmp/docs-response-test.json
