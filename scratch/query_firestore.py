import subprocess
import json
import sys
import urllib.request
import urllib.error

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

def query_doc(doc_path):
    token = get_access_token()
    url = f"https://firestore.googleapis.com/v1/projects/architect-prime-beta/databases/(default)/documents/{doc_path}"
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {token}"}
    )
    try:
        with urllib.request.urlopen(req) as response:
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as e:
        print(f"HTTP Error {e.code}: {e.read().decode()}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"Error querying doc: {e}", file=sys.stderr)
        return None

def query_collection(collection_path):
    token = get_access_token()
    # List documents
    url = f"https://firestore.googleapis.com/v1/projects/architect-prime-beta/databases/(default)/documents/{collection_path}?pageSize=300"
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {token}"}
    )
    try:
        with urllib.request.urlopen(req) as response:
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as e:
        print(f"HTTP Error {e.code}: {e.read().decode()}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"Error querying collection: {e}", file=sys.stderr)
        return None

def format_doc(doc):
    if not doc or 'fields' not in doc:
        return str(doc)
    f = doc.get('fields', {})
    res = []
    for k in sorted(f.keys()):
        val_dict = f[k]
        val = list(val_dict.values())[0]
        # if val is mapValue, format it nicely
        if 'mapValue' in val_dict:
            val = val_dict['mapValue']
        res.append(f"{k}: {val}")
    return "\n".join(res)

if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except AttributeError:
        pass
    if len(sys.argv) < 2:
        print("Usage: python query_firestore.py <doc_or_collection_path> [list]")
        sys.exit(1)
    
    path = sys.argv[1]
    is_list = len(sys.argv) > 2 and sys.argv[2] == "list"
    
    if is_list:
        data = query_collection(path)
        if data and 'documents' in data:
            for doc in data['documents']:
                name = doc['name'].split('/')[-1]
                fields = doc.get('fields', {})
                status = fields.get('status', {}).get('stringValue', '?')
                owner = fields.get('owner', {}).get('stringValue', '?')
                title = fields.get('title', {}).get('stringValue', '')
                print(f"{name} | status={status} | owner={owner} | title={title[:50]}")
        else:
            print("No documents found or error.")
    else:
        doc = query_doc(path)
        if doc:
            print(format_doc(doc))
