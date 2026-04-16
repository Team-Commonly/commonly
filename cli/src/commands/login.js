/**
 * commonly login [--instance <url>] [--key <name>]
 *
 * Authenticates and stores the token in ~/.commonly/config.json.
 * Supports multiple named instances.
 */

import { createInterface } from 'readline';
import { login as apiLogin } from '../lib/api.js';
import { saveInstance, LOCAL_URL } from '../lib/config.js';

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
    .addHelpText('after', `
Examples:
  $ commonly login                                                   # production (default key)
  $ commonly login --instance https://api-dev.commonly.me --key dev  # named profile
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

      console.log(`Logging in to ${instanceUrl}`);

      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const email = await prompt(rl, 'Email: ');
      rl.close();

      const password = await promptSecret('Password: ');

      try {
        const data = await apiLogin(instanceUrl, email.trim(), password);
        const token = data.token;
        const userId = data.user?._id || data.user?.id;
        const username = data.user?.username;

        saveInstance({ key: configKey, url: instanceUrl, token, userId, username });

        console.log(`\nLogged in as ${username} (${configKey})`);
        console.log(`Token saved to ~/.commonly/config.json`);
      } catch (err) {
        console.error(`Login failed: ${err.message}`);
        process.exit(1);
      }
    });
};

export const registerWhoami = (program) => {
  program
    .command('whoami')
    .description('Show current auth state')
    .option('--instance <url>', 'Target instance')
    .action(async (opts) => {
      const { getActiveInstance, listInstances } = await import('../lib/config.js');
      const instances = listInstances();

      if (instances.length === 0) {
        console.log('Not logged in. Run: commonly login');
        return;
      }

      instances.forEach(({ key, url, username, active, savedAt }) => {
        const marker = active ? '→' : ' ';
        console.log(`${marker} ${key}  ${username || '?'}@${url}  (saved ${new Date(savedAt).toLocaleDateString()})`);
      });
    });
};
