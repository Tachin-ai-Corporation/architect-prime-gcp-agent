import subprocess

def main():
    # 1. SCP the file
    print("Uploading script to VM...")
    subprocess.run([
        'gcloud', 'compute', 'scp',
        'scratch/remote_check.py',
        'fleet-millie:/tmp/remote_check.py',
        '--zone=us-central1-a',
        '--project=architect-prime-beta',
        '--tunnel-through-iap'
    ], shell=True)

    # 2. Run the script on the VM
    print("Executing script on VM...")
    res = subprocess.run([
        'gcloud', 'compute', 'ssh',
        'fleet-millie',
        '--zone=us-central1-a',
        '--project=architect-prime-beta',
        '--tunnel-through-iap',
        '--command', 'python3 /tmp/remote_check.py'
    ], capture_output=True, text=True, shell=True)

    print("STDOUT:")
    print(res.stdout)
    print("STDERR:")
    print(res.stderr)

if __name__ == '__main__':
    main()
