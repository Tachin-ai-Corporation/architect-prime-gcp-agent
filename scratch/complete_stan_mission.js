const { execSync } = require('child_process');
const https = require('https');

function getAccessToken() {
  try {
    return execSync('gcloud auth print-access-token', { encoding: 'utf8' }).trim();
  } catch (err) {
    console.error('Failed to get local access token:', err.message);
    process.exit(1);
  }
}

function patchFirestore(path, body, token) {
  return new Promise((resolve, reject) => {
    const url = `https://firestore.googleapis.com/v1/projects/architect-prime-beta/databases/(default)/documents/${path}?updateMask.fieldPaths=status`;
    const options = {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    };
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  const token = getAccessToken();
  console.log('Got access token. Updating Firestore...');
  try {
    const body = {
      fields: {
        status: {
          stringValue: 'complete'
        }
      }
    };
    const res = await patchFirestore('primes/chuck/work/w-1781811338796-3d0b1c0f', body, token);
    console.log('Response:', JSON.stringify(res, null, 2));
  } catch (err) {
    console.error('Error:', err);
  }
}

main();
