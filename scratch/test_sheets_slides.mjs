import { readFileSync } from 'fs';
import { getDwdToken } from '/opt/corekit/corekit/lib/dwd-auth.mjs';

const CONFIG = '/opt/corekit/corekit/chat-config.json';
const chatConfig = JSON.parse(readFileSync(CONFIG, 'utf8'));

const testScopes = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/presentations',
];

async function main() {
  for (const scope of testScopes) {
    try {
      const token = await getDwdToken({
        signerServiceAccount: chatConfig.dwdSignerSa,
        subjectEmail: chatConfig.agentUserEmail,
        scopes: scope,
      });
      console.log(`Scope [${scope}] -> SUCCESS! (Token length: ${token.length})`);
    } catch (err) {
      console.log(`Scope [${scope}] -> FAILED: ${err.message}`);
    }
  }
}
main().catch(console.error);
