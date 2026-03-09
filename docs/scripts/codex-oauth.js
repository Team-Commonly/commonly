const { loginOpenAICodex } = require('/app/node_modules/@mariozechner/pi-ai/dist/utils/oauth/openai-codex.js');
const readline = require('readline');
const net = require('net');
const fs = require('fs');
const path = require('path');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(res => rl.question(q, res));

// Pre-occupy port 1455 so loginOpenAICodex can't bind it and falls back to onPrompt
const blocker = net.createServer();
blocker.listen(1455, '127.0.0.1', async () => {
  try {
    const creds = await loginOpenAICodex({
      onAuth: async (obj) => {
        const url = typeof obj === 'string' ? obj : obj.url;
        console.log('\n=== Open this URL in your LOCAL browser ===\n');
        console.log(url);
        console.log('\n===========================================\n');
      },
      onPrompt: async () => {
        const answer = await ask('Paste the redirect URL (http://localhost:1455/auth/callback?...)\n> ');
        return answer.trim();
      },
      onProgress: (msg) => process.stdout.write('\r' + msg + '      '),
    });

    blocker.close();

    if (!creds) { console.error('\nNo credentials returned'); process.exit(1); }

    console.log('\nTokens received. Writing to auth-profiles.json...');

    const stateDir = '/state';
    const agentsDir = path.join(stateDir, 'agents');
    const profile = {
      type: 'oauth',
      provider: 'openai-codex',
      access: creds.access,
      refresh: creds.refresh,
      expires: creds.expires,
    };

    let written = 0;
    for (const agentId of fs.readdirSync(agentsDir)) {
      const authPath = path.join(agentsDir, agentId, 'agent', 'auth-profiles.json');
      if (!fs.existsSync(authPath)) continue;
      const store = JSON.parse(fs.readFileSync(authPath, 'utf8'));
      store.profiles = store.profiles || {};
      store.profiles['openai-codex:codex-cli'] = profile;
      fs.writeFileSync(authPath, JSON.stringify(store, null, 2));
      console.log('  Written:', authPath);
      written++;
    }

    console.log(`\nDone! Codex OAuth tokens saved to ${written} agent(s).`);
    console.log('Expires:', new Date(creds.expires).toISOString());

    // Print kubectl command to persist tokens to K8s Secret so they survive
    // PVC deletion and seed new agents via the init container
    console.log('\n=== IMPORTANT: Run this command locally to make tokens permanent ===\n');
    console.log(`kubectl create secret generic api-keys \\`);
    console.log(`  --from-literal=openai-codex-access-token='${creds.access}' \\`);
    console.log(`  --from-literal=openai-codex-refresh-token='${creds.refresh}' \\`);
    console.log(`  --from-literal=openai-codex-expires-at='${creds.expires}' \\`);
    console.log(`  -n commonly-dev --dry-run=client -o yaml | kubectl apply -f -`);
    console.log('\n====================================================================\n');
    console.log('This stores tokens in the K8s Secret so:');
    console.log('  - New agents get Codex tokens automatically via the init container');
    console.log('  - Tokens survive PVC deletion / full redeployment');

    rl.close();
  } catch (err) {
    blocker.close();
    console.error('\nError:', err.message || err);
    rl.close();
    process.exit(1);
  }
});
