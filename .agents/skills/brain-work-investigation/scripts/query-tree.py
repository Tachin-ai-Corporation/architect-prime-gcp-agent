#!/usr/bin/env python3
import urllib.request
import json
import ssl
import sys

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

# Parse arguments
owner_filter = sys.argv[1] if len(sys.argv) > 1 else None
target_mission_id = sys.argv[2] if len(sys.argv) > 2 else None

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
    url = 'https://firestore.googleapis.com/v1/projects/your-gcp-project/databases/(default)/documents/primes/chuck/work?pageSize=300'
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
        'delivery_status': val('delivery_status'),
        'created_at': val('created_at') or ''
    }

# Filter by owner if provided
if owner_filter:
    filtered_docs = {eid: d for eid, d in docs_map.items() if d['owner'] and owner_filter.lower() in d['owner'].lower()}
else:
    filtered_docs = docs_map

# Helper to find children
def get_children(parent_id):
    children = [d for d in docs_map.values() if d['parent_id'] == parent_id]
    children.sort(key=lambda x: x['created_at'])
    return children

# Find roots
roots = []
if target_mission_id:
    if target_mission_id in docs_map:
        roots.append(docs_map[target_mission_id])
else:
    for eid, doc in filtered_docs.items():
        is_root = False
        if doc['type'] in ('M', 'R'):
            parent_id = doc['parent_id']
            if not parent_id or parent_id not in docs_map:
                is_root = True
            else:
                parent_doc = docs_map[parent_id]
                if owner_filter and (not parent_doc['owner'] or owner_filter.lower() not in parent_doc['owner'].lower()):
                    is_root = True
        if is_root:
            roots.append(doc)

# Sort roots by created_at
roots.sort(key=lambda x: x['created_at'])

print(f"Found {len(roots)} root missions/responsibilities:")
for root in roots:
    print(f"\n==========================================")
    print(f"ROOT {root['type']}: {root['id']}")
    print(f"Title: {root['title']}")
    print(f"Status: {root['status']}")
    print(f"Created: {root['created_at']}")
    print(f"Delivery Status: {root['delivery_status']}")
    if root['output']:
        print(f"Output: {root['output'][:200]}...")
    
    # Get checkpoints
    checkpoints = get_children(root['id'])
    print(f"  Checkpoints ({len(checkpoints)}):")
    for cp in checkpoints:
        print(f"    - [Checkpoint {cp['type']}] {cp['id']}: status={cp['status']} title={cp['title']}")
        if cp['output']:
            print(f"      CP Output: {cp['output'][:150]}...")
        
        # Get tasks under this checkpoint
        tasks = get_children(cp['id'])
        print(f"      Tasks ({len(tasks)}):")
        for t in tasks:
            print(f"        * [Task {t['type']}] {t['id']}: status={t['status']} agent={t['agent']} title={t['title']}")
            if t['error']:
                print(f"          Error: {t['error']}")
            if t['output']:
                print(f"          Output (truncated): {t['output'][:300]}...")
            if t['delivery_status']:
                print(f"          Delivery Status: {t['delivery_status']}")
    
    # Direct child tasks
    direct_tasks = [d for d in get_children(root['id']) if d['type'] == 'T']
    if direct_tasks:
        print(f"  Direct Tasks ({len(direct_tasks)}):")
        for t in direct_tasks:
            print(f"    * [Task {t['type']}] {t['id']}: status={t['status']} agent={t['agent']} title={t['title']}")
            if t['error']:
                print(f"      Error: {t['error']}")
            if t['output']:
                print(f"      Output (truncated): {t['output'][:300]}...")
