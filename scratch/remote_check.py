import urllib.request
import json
import subprocess
import sys

def main():
    try:
        # Run ws-token to get bearer token
        token_res = subprocess.run(
            ['/opt/corekit/bin/ws-token', '--scope', 'drive'],
            capture_output=True, text=True, check=True
        )
        token = token_res.stdout.strip()
    except Exception as e:
        print(f"Error getting token: {e}", file=sys.stderr)
        sys.exit(1)

    url = 'https://www.googleapis.com/drive/v3/files/1FqC20zToVEA8QQM-9fJeyfM2EC0a7I4n/permissions?supportsAllDrives=true&fields=permissions(emailAddress,role,type)'
    req = urllib.request.Request(
        url,
        headers={'Authorization': f'Bearer {token}'}
    )
    try:
        with urllib.request.urlopen(req) as response:
            perms = json.loads(response.read().decode())
            print(json.dumps(perms, indent=2))
    except Exception as e:
        print(f"Error fetching permissions: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()
