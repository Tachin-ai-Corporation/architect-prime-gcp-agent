#!/usr/bin/env python3
import urllib.request
import json
import ssl
import sys

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

if len(sys.argv) < 2:
    print("Usage: query-task-details.py [task_id]")
    sys.exit(1)

task_id = sys.argv[1]

# Get token
req = urllib.request.Request(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    headers={'Metadata-Flavor': 'Google'}
)
try:
    with urllib.request.urlopen(req) as response:
        token = json.loads(response.read().decode())['access_token']
except Exception as e:
    print(f"Error fetching metadata token: {e}")
    sys.exit(1)

# Get specific document
url = f'https://firestore.googleapis.com/v1/projects/your-gcp-project/databases/(default)/documents/primes/chuck/work/{task_id}'
req = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}'})

try:
    with urllib.request.urlopen(req, context=ctx) as response:
        doc = json.loads(response.read().decode())
        fields = doc.get('fields', {})
        print(f"=== Document Details: {task_id} ===")
        for k, v in sorted(fields.items()):
            val = list(v.values())[0]
            print(f"{k}: {val}")
except Exception as e:
    print(f"Error fetching document {task_id}: {e}")
