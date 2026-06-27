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

def update_doc(doc_path, doc_data):
    token = get_access_token()
    url = f"https://firestore.googleapis.com/v1/projects/architect-prime-beta/databases/(default)/documents/{doc_path}?updateMask.fieldPaths=team"
    req = urllib.request.Request(
        url,
        data=json.dumps(doc_data).encode('utf-8'),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json"
        },
        method="PATCH"
    )
    try:
        with urllib.request.urlopen(req) as response:
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as e:
        print(f"HTTP Error {e.code}: {e.read().decode()}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"Error updating doc: {e}", file=sys.stderr)
        return None

def main():
    doc_path = "projects/tachin-website"
    doc = query_doc(doc_path)
    if not doc:
        print("Failed to fetch project doc.")
        return
    
    fields = doc.get("fields", {})
    team = fields.get("team", {})
    values = team.get("arrayValue", {}).get("values", [])
    
    updated = False
    for val in values:
        map_val = val.get("mapValue", {})
        f = map_val.get("fields", {})
        email_field = f.get("email", {})
        email_str = email_field.get("stringValue", "")
        if email_str == "chris@tachin.ag":
            email_field["stringValue"] = "chill@tachin.ai"
            updated = True
            print("Found chris@tachin.ag, updated to chill@tachin.ai")
            
    if not updated:
        print("No update needed.")
        return
        
    payload = {
        "fields": {
            "team": team
        }
    }
    
    print("Updating project team in Firestore...")
    res = update_doc(doc_path, payload)
    if res:
        print("Successfully updated tachin-website project team in Firestore.")
    else:
        print("Failed to update project team in Firestore.")

if __name__ == "__main__":
    main()
