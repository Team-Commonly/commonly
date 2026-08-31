/**
 * commonly login [--instance <url>] [--key <name>]
 *
 * Authenticates and stores the token in ~/.commonly/config.json.
 * Supports multiple named instances.
 */

import { createInterface } from 'readline';
import { hostname } from 'os';
import { createClient, login as apiLogin } from '../lib/api.js';
import { saveInstance } from '../lib/config.js';
import { DeviceLoginCancelledError, waitForDeviceAuthorization } from '../lib/device-login.js';

const prompt = (rl, question) => new Promise((resolve) => rl.question(question, resolve));

const promptSecret = (question) => new Promise((resolve) => {
  process.stdout.write(question);
  const { stdin } = process;
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  let password = '';
  const onData = (ch) => {
    if (ch === '\n' || ch === '\r' || ch === '\u0003') {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      resolve(password);
    } else if (ch === '\u007f') {
      password = password.slice(0, -1);
    } else {
      password += ch;
    }
  };
  stdin.on('data', onData);
});

export const registerLogin = (program) => {
  program
    .command('login')
    .description('Authenticate to a Commonly instance')
    .option('--instance <url>', 'Instance URL (default: https://api.commonly.me)')
    .option('--key <name>', 'Config key to save as (default: "default" or "local")')
    .option('--password', 'Use the legacy email/password prompt instead of device authorization')
    .addHelpText('after', `
Examples:
  $ commonly login                                                   # production (default key)
  $ commonly login --instance https://api.commonly.me --key dev  # named profile
  $ commonly login --instance http://localhost:5000                  # saved as "local"

Tokens are stored in ~/.commonly/config.json. Other commands take
--instance <url-or-key> to target the right profile.
`)
    .action(async (opts) => {
      const instanceUrl = opts.instance
        ? opts.instance.replace(/\/$/, '')
        : 'https://api.commonly.me';

      const isLocal = instanceUrl.includes('localhost') || instanceUrl.includes('127.0.0.1');
      const configKey = opts.key || (isLocal ? 'local' : 'default');

      try {
        if (!opts.password) {
          const client = createClient({ instance: instanceUrl, token: null });
          const started = await client.post('/api/auth/device/start', {
            clientName: 'commonly-cli',
            clientVersion: program.version(),
            hostname: hostname(),
          });
          console.log(`Open ${started.verifyUrl}`);
          console.log(`Enter code: ${started.userCode}`);
          console.log('Press o to open your browser, or q to cancel.');
          const data = await waitForDeviceAuthorization({
            client,
            deviceCode: started.deviceCode,
            userCode: started.userCode,
            verifyUrl: started.verifyUrl,
            interval: started.interval,
            expiresIn: started.expiresIn,
            onStatus: (message) => console.log(message),
          });

          saveInstance({
            key: configKey,
            url: instanceUrl,
            token: data.token,
            userId: data.userId,
            username: data.username,
            tokenType: 'device',
          });
          console.log(`\nLogged in as ${data.username} (${configKey})`);
          console.log('Device token saved to ~/.commonly/config.json');
          return;
        }

        console.log(`Logging in to ${instanceUrl}`);
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const email = await prompt(rl, 'Email: ');
        rl.close();
        const password = await promptSecret('Password: ');
        const data = await apiLogin(instanceUrl, email.trim(), password);
        const token = data.token;
        const userId = data.user?._id || data.user?.id;
        const username = data.user?.username;

        saveInstance({ key: configKey, url: instanceUrl, token, userId, username, tokenType: 'jwt' });

        console.log(`\nLogged in as ${username} (${configKey})`);
        console.log(`Token saved to ~/.commonly/config.json`);
      } catch (err) {
        const message = err instanceof DeviceLoginCancelledError ? err.message : `Login failed: ${err.message}`;
        console.error(message);
        process.exit(1);
      }
    });
};

export const registerWhoami = (program) => {
  program
    .command('whoami')
    .description('Show current auth state')
    .option('--instance <url>', 'Target instance')
    .action(async () => {
      const { listInstances } = await import('../lib/config.js');
      const instances = listInstances();

      if (instances.length === 0) {
        console.log('Not logged in. Run: commonly login');
        return;
      }

      instances.forEach(({ key, url, username, active, token, tokenType }) => {
        const marker = active ? '→' : ' ';
        console.log(`${marker} ${key}  ${username || '?'}@${url}  (${formatTokenStatus(token, tokenType, Date.now(), key)})`);
      });
    });
};

const decodeJwtExpiry = (token) => {
  if (typeof token !== 'string' || token.split('.').length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
};

export const formatTokenStatus = (token, tokenType, now = Date.now(), instanceKey = 'default') => {
  if (tokenType === 'device' || String(token || '').startsWith('cm_')) return 'device token · no expiry';
  const expiresAt = decodeJwtExpiry(token);
  if (!expiresAt) return 'session token · expiry unknown';
  const diff = expiresAt - now;
  if (diff <= 0) return `expired — commonly login --instance ${instanceKey}`;
  const hours = Math.max(1, Math.ceil(diff / (60 * 60 * 1000)));
  return `expires in ${hours}h`;
};
