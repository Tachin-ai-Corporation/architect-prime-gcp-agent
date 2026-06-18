#!/usr/bin/env python3
import urllib.request
import json
import ssl
import sys

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

owner_filter = sys.argv[1] if len(sys.argv) > 1 else None

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

# Fetch all work docs paginated
all_docs = []
page_token = None

while True:
    url = 'https://firestore.googleapis.com/v1/projects/architect-prime-beta/databases/(default)/documents/primes/chuck/work?pageSize=300'
    if page_token:
        url += f'&pageToken={page_token}'
    
    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}'})
    try:
        with urllib.request.urlopen(req, context=ctx) as response:
            data = json.loads(response.read().decode())
            documents = data.get('documents', [])
            all_docs.extend(documents)
            page_token = data.get('nextPageToken')
            if not page_token:
                break
    except Exception as e:
        print(f"Error fetching Firestore docs: {e}")
        break

# Parse all docs
docs_map = {}
for doc in all_docs:
    f = doc.get('fields', {})
    name = doc['name'].split('/')[-1]
    
    def val(k):
        if k not in f: return None
        return list(f[k].values())[0]

    docs_map[name] = {
        'id': name,
        'type': val('type'),
        'parent_id': val('parent_id'),
        'status': val('status'),
        'title': val('title'),
        'output': val('output'),
        'error': val('error'),
        'owner': val('owner'),
        'agent': val('agent'),
        'blocker': val('blocker'),
        'blocker_type': val('blocker_type'),
        'created_at': val('created_at') or ''
    }

# Filter blocked and failed
blocked_docs = []
for doc in docs_map.values():
    if doc['status'] in ('blocked', 'failed'):
        if owner_filter and (not doc['owner'] or owner_filter.lower() not in doc['owner'].lower()):
            continue
        blocked_docs.append(doc)

# Sort by created_at
blocked_docs.sort(key=lambda x: x['created_at'])

print(f"Found {len(blocked_docs)} blocked/failed documents:")
for doc in blocked_docs:
    print(f"\n------------------------------------------")
    print(f"ID: {doc['id']} (Type: {doc['type']}, Status: {doc['status']})")
    print(f"Title: {doc['title']}")
    print(f"Owner: {doc['owner']}")
    print(f"Agent: {doc['agent']}")
    print(f"Blocker: {doc['blocker']}")
    print(f"Blocker Type: {doc['blocker_type']}")
    print(f"Error: {doc['error']}")
    print(f"Parent ID: {doc['parent_id']}")
    print(f"Created At: {doc['created_at']}")
