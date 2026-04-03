/**
 * commonly dev <subcommand>
 *
 * up    — start local Commonly instance (wraps ./dev.sh up)
 * down  — stop local instance
 * logs  — tail local instance logs
 * test  — run backend tests
 *
 * Sets --instance http://localhost:5000 automatically after `dev up`.
 */

import { spawnSync, spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { saveInstance, getToken } from '../lib/config.js';
import { createClient } from '../lib/api.js';

const findDevSh = () => {
  // Walk up from cwd to find dev.sh (works from anywhere in the repo)
  let dir = process.cwd();
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
  if (opts.stream) {
    return spawn('bash', [devSh, ...args], { stdio: 'inherit' });
  }
  const result = spawnSync('bash', [devSh, ...args], { stdio: 'inherit' });
  return result;
};

export const registerDev = (program) => {
  const dev = program.command('dev').description('Local development environment');

  // ── up ────────────────────────────────────────────────────────────────────
  dev
    .command('up')
    .description('Start local Commonly instance')
    .option('--with-gateway', 'Also start the clawdbot gateway', false)
    .action(async (opts) => {
      runDevSh(['up']);
      if (opts.withGateway) runDevSh(['clawdbot', 'up']);

      // Auto-save local instance config (token will be filled on first login)
      saveInstance({
        key: 'local',
        url: 'http://localhost:5000',
        token: getToken('local') || null,
        username: null,
        userId: null,
      });

      console.log('\nLocal instance ready:');
      console.log('  Frontend: http://localhost:3000');
      console.log('  Backend:  http://localhost:5000');
      console.log('\nLogin to local instance:');
      console.log('  commonly login --instance http://localhost:5000 --key local');
    });

  // ── down ──────────────────────────────────────────────────────────────────
  dev
    .command('down')
    .description('Stop local Commonly instance')
    .action(() => {
      runDevSh(['down']);
    });

  // ── logs ──────────────────────────────────────────────────────────────────
  dev
    .command('logs [service]')
    .description('Tail logs (backend, frontend, mongo, postgres)')
    .option('--follow', 'Stream logs continuously', true)
    .action((service) => {
      const args = service ? ['logs', service] : ['logs'];
      runDevSh(args, { stream: true });
    });

  // ── test ──────────────────────────────────────────────────────────────────
  dev
    .command('test')
    .description('Run tests')
    .option('--watch', 'Watch mode', false)
    .option('--frontend', 'Frontend tests only', false)
    .option('--backend', 'Backend tests only', false)
    .action((opts) => {
      const devSh = findDevSh();
      if (!devSh) { console.error('dev.sh not found'); process.exit(1); }

      if (!opts.frontend) runDevSh(['test']); // backend
      if (!opts.backend) {
        const dir = join(findDevSh(), '../frontend');
        if (existsSync(dir)) {
          const watchFlag = opts.watch ? '' : '-- --watchAll=false';
          spawnSync('npm', ['test', ...(opts.watch ? [] : ['--', '--watchAll=false'])], {
            cwd: dir, stdio: 'inherit', shell: true,
          });
        }
      }
    });

  // ── status ────────────────────────────────────────────────────────────────
  dev
    .command('status')
    .description('Check health of local instance')
    .action(async () => {
      const client = createClient({ instance: 'http://localhost:5000', token: null });
      try {
        const data = await client.get('/api/health');
        console.log('Local instance: healthy');
        console.log(JSON.stringify(data, null, 2));
      } catch {
        console.log('Local instance: not running (start with: commonly dev up)');
      }
    });
};
