import subprocess
import json
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone
import time

def get_access_token():
    try:
        res = subprocess.run(
            ["gcloud", "auth", "print-access-token", "--project=architect-prime-beta"],
            capture_output=True,
            text=True,
            check=True,
            shell=True
        )
        return res.stdout.strip()
    except Exception as e:
        print(f"Error getting token: {e}", file=sys.stderr)
        sys.exit(1)

def inject_intake():
    token = get_access_token()
    intake_id = f"intake-{int(time.time())}"
    url = f"https://firestore.googleapis.com/v1/projects/architect-prime-beta/databases/(default)/documents/primes/candicejr/intake/{intake_id}"
    
    now_ts = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    
    intake_doc = {
        "fields": {
            "id": {"stringValue": intake_id},
            "text": {"stringValue": "@Assistant-Agent Millie please share the project 'legal-processes' Drive folder and its documents with me."},
            "source": {"stringValue": "gchat"},
            "status": {"stringValue": "pending"},
            "created_at": {"timestampValue": now_ts},
            "source_meta": {
                "mapValue": {
                    "fields": {
                        "taskId": {"stringValue": f"t-{int(time.time())}-test"},
                        "agentEmail": {"stringValue": "assistant-agent-millie@tachin.ag"},
                        "agentId": {"stringValue": "millie"},
                        "senderEmail": {"stringValue": "chill@tachin.ai"},
                        "primeId": {"stringValue": "candicejr"},
                        "address": {
                            "mapValue": {
                                "fields": {
                                    "channel": {"stringValue": "gchat"},
                                    "space": {"stringValue": "spaces/AAQAWx8gWqw"},
                                    "thread": {"stringValue": "spaces/AAQAWx8gWqw/threads/1IAKYA30CK0"}
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    
    req = urllib.request.Request(
        url,
        data=json.dumps(intake_doc).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json"
        },
        method="PATCH"
    )
    
    try:
        with urllib.request.urlopen(req) as response:
            print("Successfully injected intake document:")
            print(json.loads(response.read().decode()))
    except urllib.error.HTTPError as e:
        print(f"HTTP Error {e.code}: {e.read().decode()}", file=sys.stderr)
    except Exception as e:
        print(f"Error injecting intake: {e}", file=sys.stderr)

if __name__ == "__main__":
    inject_intake()
