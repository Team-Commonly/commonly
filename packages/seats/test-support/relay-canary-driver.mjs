#!/usr/bin/env node
/**
 * Runs supervised turns through the provider relay inside a directory of its
 * own, so a test can search every file the run wrote: the trace store, this
 * process's stdout and stderr (the test redirects them to files there), and
 * anything written relative to HOME, TMPDIR or the cwd, which the test also
 * points there.
 *
 *   node relay-canary-driver.mjs <runDir>
 *   env: CANARY_AUTH, CANARY_KEY, CANARY_ACCOUNT, CANARY_BETA (auth headers),
 *        CANARY_PROMPT (request body), CANARY_REFUSAL, CANARY_REPLY (response bodies)
 *
 * Prints one JSON line of verdicts: outcomes, failure kinds, relay statuses,
 * and whether each canary reached the provider. Never a canary itself.
 */
import { join } from 'node:path';
import { startFakeProvider } from './fake-provider.js';
import { createRelayStubAdapter } from './relay-stub-adapter.js';
import { createTraceStore } from '../src/trace/store.js';
import { superviseRun } from '../src/supervisor.js';
import { failureKindOf } from '../src/failures.js';

const [runDir] = process.argv.slice(2);
const env = process.env;
const headers = {
  authorization: `Bearer ${env.CANARY_AUTH}`,
  'x-api-key': env.CANARY_KEY,
  'anthropic-beta': env.CANARY_BETA,
  'anthropic-version': '2023-06-01',
  'chatgpt-account-id': env.CANARY_ACCOUNT,
};

const fake = await startFakeProvider({
  script: [{ refuse: env.CANARY_REFUSAL, refuseAs: 'inband' }, { text: env.CANARY_REPLY }],
});
const store = createTraceStore({ root: join(runDir, 'trace') });
const runs = [];
try {
  for (const wire of ['responses', 'anthropic']) {
    const adapter = createRelayStubAdapter({
      upstream: wire === 'anthropic' ? fake.anthropicBaseURL : fake.baseURL, wire, headers,
    });
    // eslint-disable-next-line no-await-in-loop
    const out = await superviseRun({ adapter, prompt: env.CANARY_PROMPT, store, relay: {} });
    runs.push({
      outcome: out.outcome,
      kind: failureKindOf(out.failure),
      relay: out.relay.status,
      refusals: out.relay.refusals.length,
    });
  }
  const reached = Object.fromEntries(['CANARY_AUTH', 'CANARY_KEY', 'CANARY_ACCOUNT', 'CANARY_BETA', 'CANARY_PROMPT']
    .map((name) => [name, fake.findInRequests(env[name]).length > 0]));
  process.stdout.write(`${JSON.stringify({ runs, reached })}\n`);
} finally {
  await fake.close();
}
