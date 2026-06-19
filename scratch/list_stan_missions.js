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

function fetchFirestore(path, token) {
  return new Promise((resolve, reject) => {
    const url = `https://firestore.googleapis.com/v1/projects/architect-prime-beta/databases/(default)/documents/${path}?pageSize=300`;
    const options = {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    };
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  const token = getAccessToken();
  console.log('Got access token. Querying Firestore...');
  try {
    const data = await fetchFirestore('primes/chuck/work', token);
    if (data.error) {
      console.error('Firestore Error:', data.error.message);
      return;
    }
    const docs = data.documents || [];
    
    console.log(`\nFound ${docs.length} total work documents.`);
    
    const stanMissions = [];
    for (const doc of docs) {
      const name = doc.name.split('/').pop();
      const fields = doc.fields || {};
      
      const type = fields.type ? Object.values(fields.type)[0] : '?';
      const owner = fields.owner ? Object.values(fields.owner)[0] : '?';
      
      if (type === 'M' && owner === 'devops-agent-stan@tachin.ag') {
        const status = fields.status ? Object.values(fields.status)[0] : '?';
        const title = fields.title ? Object.values(fields.title)[0] : '';
        const created_at = fields.created_at ? Object.values(fields.created_at)[0] : '';
        const instruction = fields.instruction ? Object.values(fields.instruction)[0] : '';
        stanMissions.push({ name, status, title, created_at, instruction });
      }
    }
    
    // Sort by created_at descending
    stanMissions.sort((a, b) => b.created_at.localeCompare(a.created_at));
    
    console.log(`\nStan Missions (${stanMissions.length}):`);
    stanMissions.forEach(m => {
      console.log(`- ID: ${m.name}`);
      console.log(`  Status: ${m.status}`);
      console.log(`  Created: ${m.created_at}`);
      console.log(`  Title: ${m.title}`);
      console.log(`  Instruction: ${m.instruction.substring(0, 150)}...`);
      console.log();
    });
  } catch (err) {
    console.error('Error:', err);
  }
}

main();
