#!/usr/bin/env node
/**
 * The `jellymoon` program exactly as src/jellymoon.js builds it, with one
 * agent bound: `fake-cli`, the test-support CLI (a real child process) that
 * calls the fake provider. Only the adapter table differs from the shipped bin.
 *
 *   JM_FAKE_PROVIDER_URL  the fake provider's base URL (required for a turn)
 *   JM_FAKE_CLI_BIN       the fake CLI's path; point it at nothing to be "not installed"
 *
 * CommonJS with dynamic imports only so Jest's testMatch (`__tests__/**` .js
 * and .mjs) does not collect this script as a suite.
 */
(async () => {
  const { buildJellymoonProgram } = await import('../../src/commands/jellymoon.js');
  const { createFakeCliAdapter } = await import('../../../packages/seats/test-support/fake-cli-adapter.js');
  const base = createFakeCliAdapter(process.env.JM_FAKE_CLI_BIN ? { bin: process.env.JM_FAKE_CLI_BIN } : {});
  const fakeCli = {
    ...base,
    detect: () => base.detect(),
    spawn: (prompt, ctx) => base.spawn(prompt, {
      ...ctx,
      provider: { baseURL: process.env.JM_FAKE_PROVIDER_URL, model: 'fake-model', apiKey: 'fake-key-0123456789' },
    }),
  };
  await buildJellymoonProgram({ adapters: { 'fake-cli': fakeCli }, version: '0.0.0-test' }).parseAsync(process.argv);
})();
