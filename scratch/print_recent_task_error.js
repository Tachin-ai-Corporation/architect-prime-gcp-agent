const { execSync } = require('child_process');
const https = require('https');

function getAccessToken() {
  try {
    return execSync('gcloud auth print-access-token', { encoding: 'utf8' }).trim();
  } catch (err) {
    console.error('Failed to get token:', err.message);
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
  try {
    const data = await fetchFirestore('primes/chuck/work', token);
    const docs = data.documents || [];
    
    const tasks = docs
      .filter(doc => {
        const fields = doc.fields || {};
        const type = fields.type ? Object.values(fields.type)[0] : '';
        return type === 'T';
      })
      .map(doc => {
        const fields = doc.fields || {};
        const name = doc.name.split('/').pop();
        const created_at = fields.created_at ? Object.values(fields.created_at)[0] : '';
        const instruction = fields.instruction ? Object.values(fields.instruction)[0] : '';
        const output = fields.output ? Object.values(fields.output)[0] : '';
        const error = fields.error ? Object.values(fields.error)[0] : '';
        const status = fields.status ? Object.values(fields.status)[0] : '';
        return { name, created_at, instruction, output, error, status };
      });
      
    tasks.sort((a, b) => b.created_at.localeCompare(a.created_at));
    
    if (tasks.length === 0) {
      console.log('No tasks found.');
      return;
    }
    
    // Print the 2 most recent tasks
    for (let i = 0; i < Math.min(tasks.length, 2); i++) {
      const t = tasks[i];
      console.log(`\n=== TASK ${i} ===`);
      console.log('ID:', t.name);
      console.log('Created:', t.created_at);
      console.log('Status:', t.status);
      console.log('Instruction:', t.instruction);
      console.log('Error:', JSON.stringify(t.error));
    }
  } catch (err) {
    console.error(err);
  }
}

main();
