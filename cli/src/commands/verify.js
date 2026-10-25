/** Repository verification entry point; scenario implementations live in backend. */
import { existsSync } from 'fs';
import { resolve, join } from 'path';
import { spawnSync } from 'child_process';

const SCENARIOS = {
  wave1: '__tests__/service/verify.wave1.test.js',
  'first-reply': '__tests__/service/verify.firstReply.test.js',
};
const testDatabase = (name) => /^(test|verify)([-_0-9]|$)|[-_]test$/.test(name || '');

export const verificationPlan = (scenario, repo, env = process.env) => {
  const suite = SCENARIOS[scenario];
  if (!suite) throw new Error(`Unknown scenario: ${scenario}. Choose wave1 or first-reply.`);
  let mongoDatabase = '';
  try { mongoDatabase = decodeURIComponent(new URL(env.MONGO_URI).pathname.slice(1)); } catch { /* refused below */ }
  if (!env.PG_HOST || !testDatabase(env.PG_DATABASE) || !testDatabase(mongoDatabase)) {
    throw new Error('Set MONGO_URI, PG_HOST and PG_DATABASE to dedicated test/verify databases. Fixture setup clears their data.');
  }
  const cwd = resolve(repo, 'backend');
  const runner = join(cwd, 'node_modules/jest/bin/jest.js');
  if (!existsSync(join(cwd, suite)) || !existsSync(runner)) {
    throw new Error('Use --repo with a Commonly checkout containing the scenario and installed backend dependencies.');
  }
  return { command: process.execPath, args: [runner, '--runInBand', '--forceExit', '--runTestsByPath', suite,
    ...(env.COMMONLY_VERIFY_CACHE_DIR ? ['--cacheDirectory', env.COMMONLY_VERIFY_CACHE_DIR] : [])],
    options: { cwd, stdio: 'inherit', env: { ...env, INTEGRATION_TEST: 'true' } } };
};

export const registerVerify = (program, run = spawnSync) => {
  program.command('verify <scenario>')
    .description('Run shared real-HTTP scenarios against isolated test databases (wave1 or first-reply)')
    .option('--repo <path>', 'Commonly checkout with backend test dependencies', process.cwd())
    .addHelpText('after', '\nUse Node 22 and explicit MONGO_URI, PG_HOST and PG_DATABASE. Fixture databases are cleared.\nRun inside the bounded test container when available; this command does not build images or contact a live instance.\n')
    .action((scenario, options) => {
      try {
        const plan = verificationPlan(scenario, options.repo);
        const result = run(plan.command, plan.args, plan.options);
        if (result.error) throw result.error;
        process.exitCode = result.status === null ? 1 : result.status;
      } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
      }
    });
};
