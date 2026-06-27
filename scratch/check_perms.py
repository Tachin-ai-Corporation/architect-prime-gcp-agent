import subprocess
import sys

def main():
    cmd = 'TOKEN=$(/opt/corekit/bin/ws-token --scope drive); curl -s -H "Authorization: Bearer $TOKEN" "https://www.googleapis.com/drive/v3/files/1FqC20zToVEA8QQM-9fJeyfM2EC0a7I4n/permissions?supportsAllDrives=true&fields=permissions(emailAddress,role,type)"'
    
    # We pass the list of arguments to subprocess.run to bypass shell parser
    res = subprocess.run([
        'gcloud', 'compute', 'ssh', 'fleet-millie',
        '--zone=us-central1-a',
        '--project=architect-prime-beta',
        '--tunnel-through-iap',
        '--command', cmd
    ], capture_output=True, text=True, shell=True)
    
    print("STDOUT:")
    print(res.stdout)
    print("STDERR:")
    print(res.stderr)

if __name__ == '__main__':
    main()
