// Usage:
//   node codex-oauth.js [--account=2] [--device-auth]
//
// --account=2    : set up fallback account (profile: openai-codex:account-2)
// --device-auth  : headless device code flow — no redirect URL to paste,
//                  just visit a short URL + enter a code on any device
//
// Default (no flags): PKCE flow for account 1, requires pasting redirect URL

const { loginOpenAICodex } = require('/app/node_modules/@mariozechner/pi-ai/dist/utils/oauth/openai-codex.js');
const readline = require('readline');
const net = require('net');
const fs = require('fs');
const path = require('path');
const https = require('https');

const accountArg = process.argv.find((a) => a.startsWith('--account='));
const accountNum = accountArg ? accountArg.split('=')[1] : '1';
const isAccount2 = accountNum === '2';
const useDeviceAuth = process.argv.includes('--device-auth');
const suffix = isAccount2 ? '-2' : '';
const profileKey = isAccount2 ? 'openai-codex:account-2' : 'openai-codex:codex-cli';
const label = isAccount2 ? 'account-2' : 'account-1';

// Client ID extracted from @mariozechner/pi-ai openai-codex oauth module
const CODEX_CLIENT_ID = process.env.OPENAI_CODEX_CLIENT_ID || 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_SCOPES = 'openid profile email offline_access';
const AUTH_BASE = 'https://auth.openai.com';

console.log(`\nCodex OAuth ${label} — ${useDeviceAuth ? 'device code flow' : 'PKCE flow'} (profile: ${profileKey})\n`);

// ── Helpers ──────────────────────────────────────────────────────────────────

function httpsPost(url, params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Device auth flow ──────────────────────────────────────────────────────────

async function loginWithDeviceAuth() {
  // Step 1: request device + user code
  const deviceRes = await httpsPost(`${AUTH_BASE}/oauth/device/code`, {
    client_id: CODEX_CLIENT_ID,
    scope: CODEX_SCOPES,
  });

  if (deviceRes.status !== 200) {
    throw new Error(`Device code request failed (${deviceRes.status}): ${JSON.stringify(deviceRes.body)}`);
  }

  const { device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval = 5 } = deviceRes.body;

  console.log('=== Activate on any device ===\n');
  console.log(`URL:  ${verification_uri_complete || verification_uri}`);
  console.log(`Code: ${user_code}`);
  console.log('\n==============================\n');
  console.log('Waiting for approval...');

  // Step 2: poll for token
  const deadline = Date.now() + expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const tokenRes = await httpsPost(`${AUTH_BASE}/oauth/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code,
      client_id: CODEX_CLIENT_ID,
    });

    if (tokenRes.status === 200 && tokenRes.body.access_token) {
      const { access_token, refresh_token, expires_in: expiresIn } = tokenRes.body;
      const expires = Date.now() + (expiresIn || 3600) * 1000;
      console.log('\nApproved!');
      return { access: access_token, refresh: refresh_token, expires };
    }

    const err = tokenRes.body?.error;
    if (err === 'authorization_pending' || err === 'slow_down') continue;
    throw new Error(`Token poll failed (${tokenRes.status}): ${JSON.stringify(tokenRes.body)}`);
  }

  throw new Error('Device code expired before approval.');
}

// ── PKCE flow (existing) ──────────────────────────────────────────────────────

async function loginWithPkce() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));

  // Pre-occupy port 1455 so loginOpenAICodex can't bind it and falls back to onPrompt
  const blocker = net.createServer();
  await new Promise((res) => blocker.listen(1455, '127.0.0.1', res));

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
    rl.close();
    return creds;
  } catch (err) {
    blocker.close();
    rl.close();
    throw err;
  }
}

// ── Write tokens to agent files ───────────────────────────────────────────────

function writeTokens(creds) {
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
    store.profiles[profileKey] = profile;

    // Rebuild authOrder with all present codex profiles in priority order
    const order = ['openai-codex:codex-cli', 'openai-codex:account-2'].filter((id) => store.profiles[id]);
    if (order.length > 0) {
      store.authOrder = store.authOrder || {};
      store.authOrder['openai-codex'] = order;
    }

    fs.writeFileSync(authPath, JSON.stringify(store, null, 2));
    console.log('  Written:', authPath);
    written++;
  }

  // Account 1 also updates ~/.codex/auth.json for acpx chatgpt auth mode
  if (!isAccount2) {
    const codexAuth = {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: { access_token: creds.access, refresh_token: creds.refresh },
      last_refresh: new Date().toISOString(),
    };
    const sharedPath = path.join(stateDir, '.codex', 'auth.json');
    fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
    fs.writeFileSync(sharedPath, JSON.stringify(codexAuth, null, 2));
    try {
      fs.mkdirSync('/home/node/.codex', { recursive: true });
      fs.writeFileSync('/home/node/.codex/auth.json', JSON.stringify(codexAuth, null, 2));
    } catch (_) {}
    console.log('  Written: ~/.codex/auth.json (chatgpt format for acpx)');
  }

  return written;
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  try {
    const creds = useDeviceAuth ? await loginWithDeviceAuth() : await loginWithPkce();
    if (!creds) { console.error('\nNo credentials returned'); process.exit(1); }

    console.log(`\nTokens received. Writing ${profileKey} to auth-profiles.json...`);
    const written = writeTokens(creds);

    console.log(`\nDone! Saved to ${written} agent(s). Expires: ${new Date(creds.expires).toISOString()}`);

    console.log(`\n=== Run this locally to make ${label} tokens permanent ===\n`);
    console.log(`kubectl create secret generic api-keys \\`);
    console.log(`  --from-literal=openai-codex-access-token${suffix}='${creds.access}' \\`);
    console.log(`  --from-literal=openai-codex-refresh-token${suffix}='${creds.refresh}' \\`);
    console.log(`  --from-literal=openai-codex-expires-at${suffix}='${creds.expires}' \\`);
    console.log(`  -n commonly-dev --dry-run=client -o yaml | kubectl apply -f -`);
    console.log('\n=========================================================\n');
    if (isAccount2) {
      console.log('OpenClaw will fall back to this account when account-1 is rate-limited.');
    }
  } catch (err) {
    console.error('\nError:', err.message || err);
    process.exit(1);
  }
})();
