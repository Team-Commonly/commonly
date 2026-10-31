import { jest, describe, it, expect, afterEach, afterAll } from '@jest/globals';
import { Command } from 'commander';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { SCENARIOS, registerVerify, verificationPlan } from '../src/commands/verify.js';
const repo = mkdtempSync(join(tmpdir(), 'commonly-verify-'));
mkdirSync(join(repo, 'backend/node_modules/jest/bin'), { recursive: true });
mkdirSync(join(repo, 'backend/__tests__/service'), { recursive: true });
for (const file of ['node_modules/jest/bin/jest.js', '__tests__/service/verify.wave1.test.js', '__tests__/service/verify.connectorGrant.test.js']) {
  writeFileSync(join(repo, 'backend', file), '');
}
afterAll(() => rmSync(repo, { recursive: true, force: true }));
const env = { MONGO_URI: 'mongodb://mongo:27017/verify527', PG_HOST: 'pg', PG_DATABASE: 'verify527' };

afterEach(() => { process.exitCode = 0; jest.restoreAllMocks(); });
describe('commonly verify shared scenario selector', () => {
  it('registers verify through the shipped CLI entrypoint', () => {
    const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
    const help = execFileSync(process.execPath, [entry, 'verify', '--help'], { encoding: 'utf8', timeout: 15000 });
    for (const scenario of ['wave1', 'connector-grant']) expect(help).toContain(scenario);
  });
  it('lists only scenarios whose suite exists in this repository', () => {
    const backend = fileURLToPath(new URL('../../backend/', import.meta.url));
    expect(Object.keys(SCENARIOS).length).toBeGreaterThan(0);
    for (const suite of Object.values(SCENARIOS)) expect(existsSync(join(backend, suite))).toBe(true);
  });
  it.each(['mongodb://mongo1:27017,mongo2:27017/verify527', 'mongodb+srv://mongo.example.test/verify527'])('accepts MongoDB seed-list/SRV database paths: %s', (uri) => {
    expect(verificationPlan('connector-grant', repo, { ...env, MONGO_URI: uri }).options.env.MONGO_URI).toBe(uri);
  });
  it.each([
    ['wave1', 'verify.wave1'],
    ['connector-grant', 'verify.connectorGrant'],
  ])('selects the existing %s HTTP harness without a shell', (scenario, suite) => {
    const plan = verificationPlan(scenario, repo, env);
    expect(plan.command).toBe(process.execPath);
    expect(plan.args).toContain('--runTestsByPath');
    expect(plan.args.at(-1)).toContain(suite);
    expect(plan.options.env.INTEGRATION_TEST).toBe('true');
    expect(plan.options.shell).toBeUndefined();
  });
  it.each([
    { ...env, MONGO_URI: 'mongodb://mongo:27017/commonly' },
    { ...env, PG_DATABASE: 'production' },
    { ...env, PG_HOST: '' },
    { ...env, MONGO_URI: undefined },
  ])('refuses non-test or implicit databases before spawning %#', (unsafe) => {
    expect(() => verificationPlan('wave1', repo, unsafe)).toThrow('dedicated test/verify');
  });
  it('refuses unknown scenarios and missing checkout dependencies', () => {
    expect(() => verificationPlan('arbitrary', repo, env)).toThrow('Unknown scenario');
    expect(() => verificationPlan('wave1', '/no-such-checkout', env)).toThrow('Commonly checkout');
  });
  it('propagates the scenario exit status through the actual Commander action', async () => {
    const prior = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.assign(process.env, env);
    try {
      const run = jest.fn(() => ({ status: 7 }));
      const program = new Command();
      registerVerify(program, run);
      await program.parseAsync(['node', 'commonly', 'verify', 'connector-grant', '--repo', repo]);
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0][1]).toContain('__tests__/service/verify.connectorGrant.test.js');
      expect(process.exitCode).toBe(7);
    } finally {
      for (const key of Object.keys(env)) {
        if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key];
      }
    }
  });
});
