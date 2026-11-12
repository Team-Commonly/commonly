import { EventEmitter } from 'node:events';
import { createRuntimeReporter, observeSpawn } from '../src/lib/runtime-observation.js';
import { collectRuntimeInventory } from '../src/lib/runtime-inventory.js';

test('an exec error is not a spawn receipt; no argv or environment escapes', () => {
  const child = new EventEmitter();
  const reports = [];
  child.on('error', () => {});
  observeSpawn(child, (body) => reports.push(body), { model: 'm', effort: 'high', argv: ['SECRET'] });
  child.emit('error', new Error('ENOENT'));
  expect(reports).toEqual([]);
  child.emit('spawn');
  expect(reports).toEqual([expect.objectContaining({ model: 'm', effort: 'high' })]);
  expect(Number.isFinite(Date.parse(reports[0].at))).toBe(true);
});

test('a fast completion cannot overtake its spawn receipt', async () => {
  const reports = [];
  let release;
  const reporter = createRuntimeReporter({ harness: 'codex', detect: async () => ({ version: '1.2.3', path: 'PRIVATE' }),
    client: { post: async (_url, body) => {
      reports.push(body);
      if (body.event === 'spawn') await new Promise((resolve) => { release = resolve; });
    } } });
  await reporter.connect();
  const spawned = reporter.spawn({ model: 'm', effort: null });
  const settled = reporter.settled();
  await new Promise(setImmediate);
  expect(reports.map((row) => row.event)).toEqual(['connected', 'spawn']);
  release();
  await Promise.all([spawned, settled]);
  expect(reports).toEqual([{ event: 'connected' },
    { event: 'spawn', harness: 'codex', version: '1.2.3', model: 'm', effort: null }, { event: 'settled' }]);
});

test('diagnostic outages do not reject the turn', async () => {
  const offline = createRuntimeReporter({ harness: 'codex', detect: async () => { throw Error(); },
    client: { post: async () => { throw Error(); } } });
  await expect(offline.connect()).resolves.toBeUndefined();
});

test('failed probes stay disabled and unknown inventories stay explicit', async () => {
  const inventory = await collectRuntimeInventory((name) => ({ detect: async () => {
    if (name === 'hermes') throw Error('unsupported version');
    return name === 'codex' ? { version: '1.2', path: '/PRIVATE/bin' } : null;
  } }), async () => ({ models: null, efforts: [] }));
  expect(inventory.find((row) => row.harness === 'codex')).toEqual({
    harness: 'codex', installed: true, version: '1.2', models: null, efforts: [],
  });
  expect(inventory.find((row) => row.harness === 'hermes').installed).toBe(false);
  expect(JSON.stringify(inventory)).not.toContain('PRIVATE');
});

test('flag-shaped model values are consumed as data and cannot manufacture an effort receipt', async () => {
  const { controlsFromArguments } = await import('../src/lib/runtime-observation.js');
  expect(controlsFromArguments(['--model', '--effort', '--effort', 'high'], {
    modelFlag: '--model', effortFlag: '--effort',
  })).toEqual({ model: '--effort', effort: 'high' });
  expect(controlsFromArguments(['-c', 'model_reasoning_effort="xhigh"', '--model', 'm', '-o', '--model'], {
    modelFlag: '--model', valueFlags: ['-c', '-o'], codex: true,
  })).toEqual({ model: 'm', effort: 'xhigh' });
});

// F370 #11: a failed spawn carries its reason code; a backend from before the
// field refuses it with a 400, and the outcome is sent again without it.
test('a failed settle carries its reason, and a 400 resends the outcome alone', async () => {
  const sent = [];
  let refuse = false;
  const reporter = createRuntimeReporter({ harness: 'claude', detect: async () => null, client: { post: async (_url, body) => {
    sent.push(body);
    if (refuse && body.reason) throw Object.assign(new Error('invalid_runner_observation'), { status: 400 });
  } } });
  await reporter.settled('failed', 'claude-signed-out');
  await reporter.settled('completed', 'claude-signed-out');
  expect(sent).toEqual([
    { event: 'settled', outcome: 'failed', reason: 'claude-signed-out' },
    { event: 'settled', outcome: 'completed' },
  ]);
  sent.length = 0;
  refuse = true;
  await reporter.settled('failed', 'login');
  expect(sent).toEqual([
    { event: 'settled', outcome: 'failed', reason: 'login' },
    { event: 'settled', outcome: 'failed' },
  ]);
});

test('a refusal other than a 400 is not resent, and never rejects the turn', async () => {
  const sent = [];
  const reporter = createRuntimeReporter({ harness: 'claude', detect: async () => null, client: { post: async (_url, body) => {
    sent.push(body);
    throw Object.assign(new Error('down'), { status: 503 });
  } } });
  await expect(reporter.settled('failed', 'login')).resolves.toBeUndefined();
  expect(sent).toEqual([{ event: 'settled', outcome: 'failed', reason: 'login' }]);
});
