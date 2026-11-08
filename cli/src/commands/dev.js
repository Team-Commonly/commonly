/**
 * commonly dev <subcommand>
 *
 * up        — start local Commonly instance (wraps ./dev.sh up)
 * clawdbot  — refuses: the local OpenClaw gateway was retired (ADR-021 Part B)
 * down      — stop local instance
 * logs      — tail local instance logs
 * test      — run backend tests
 *
 * Sets --instance http://localhost:5000 automatically after `dev up`.
 */

import { spawnSync, spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { saveInstance, getToken, LOCAL_URL } from '../lib/config.js';
import { createClient } from '../lib/api.js';

const findDevSh = (startDir = process.cwd()) => {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'dev.sh');
    if (existsSync(candidate)) return candidate;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
};

const runDevSh = (args, opts = {}) => {
  const devSh = findDevSh();
  if (!devSh) {
    console.error('dev.sh not found — run this command from within the commonly repo');
    process.exit(1);
  }

  const spawnOpts = {
    stdio: 'inherit',
    env: { ...process.env, ...(opts.env || {}) },
  };

  if (opts.stream) {
    return spawn('bash', [devSh, ...args], spawnOpts);
  }

  return spawnSync('bash', [devSh, ...args], spawnOpts);
};

const ensureLocalInstanceConfig = () => {
  saveInstance({
    key: 'local',
    url: LOCAL_URL,
    token: getToken('local') || null,
    username: null,
    userId: null,
  });
};

export const registerDev = (program) => {
  const dev = program.command('dev').description('Local development environment');

  dev.addHelpText('after', `
Examples:
  $ commonly dev up                         # Start a local docker-compose stack
  $ commonly dev status                     # Check health
  $ commonly dev logs backend               # Tail backend logs
  $ commonly dev down                       # Stop everything

Login against the local instance with:
  $ commonly login --instance http://localhost:5000
`);

  dev
    .command('up')
    .description('Start local Commonly instance')
    .action(async () => {
      runDevSh(['up']);

      ensureLocalInstanceConfig();

      console.log('\nLocal instance ready:');
      console.log('  Frontend: http://localhost:3000');
      console.log('  Backend:  http://localhost:5000');
      console.log('\nLogin to local instance:');
      console.log('  commonly login --instance http://localhost:5000 --key local');
    });

  dev
    .command('clawdbot')
    .description('Retired: the local OpenClaw gateway is gone (ADR-021 Part B)')
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      console.error('The local OpenClaw gateway was retired (ADR-021 Part B), so `commonly dev clawdbot` no longer does anything.');
      console.error('Use native agents, or attach a local CLI with: commonly agent attach <cli>');
      process.exit(1);
    });

  dev
    .command('down')
    .description('Stop local Commonly instance')
    .action(() => {
      runDevSh(['down']);
    });

  dev
    .command('logs [service]')
    .description('Tail logs (backend, frontend, mongo, postgres)')
    .option('--follow', 'Stream logs continuously', true)
    .action((service) => {
      const args = service ? ['logs', service] : ['logs'];
      runDevSh(args, { stream: true });
    });

  dev
    .command('test')
    .description('Run tests')
    .option('--watch', 'Watch mode', false)
    .option('--frontend', 'Frontend tests only', false)
    .option('--backend', 'Backend tests only', false)
    .action((opts) => {
      const devSh = findDevSh();
      if (!devSh) { console.error('dev.sh not found'); process.exit(1); }

      if (!opts.frontend) runDevSh(['test']);
      if (!opts.backend) {
        const dir = join(findDevSh(), '../frontend');
        if (existsSync(dir)) {
          spawnSync('npm', ['test', ...(opts.watch ? [] : ['--', '--watchAll=false'])], {
            cwd: dir,
            stdio: 'inherit',
            shell: true,
          });
        }
      }
    });

  dev
    .command('status')
    .description('Check health of local instance')
    .action(async () => {
      const client = createClient({ instance: LOCAL_URL, token: null });
      try {
        const data = await client.get('/api/health');
        console.log('Local instance: healthy');
        console.log(JSON.stringify(data, null, 2));
      } catch {
        console.log('Local instance: not running (start with: commonly dev up)');
      }
    });
};
