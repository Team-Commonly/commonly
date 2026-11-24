/**
 * TASK-019 — the instruction an owner is given must match the seat's runtime.
 *
 * `commonly agent run <name>` starts a polling BYO wrapper and nothing else.
 * It was hard-coded for every runtime, so a webhook seat's owner was told to
 * run a command that fails with "No token" and starts the wrong program.
 */

const {
  runInstructionFor,
  classifyRuntime,
  WEBHOOK_RUN_INSTRUCTION,
} = require('../../../services/agentStateService');

const fs = require('fs');
const path = require('path');
const { CLI_NPX_COMMAND } = require('../../../services/cliNpxCommand');

const seat = (runtime, agentName = 'Echo-Bot') => ({
  agentName,
  instanceId: 'default',
  config: { runtime },
});

describe('runInstructionFor (TASK-019)', () => {
  // F582: `npm i -g` stops with EACCES on a stock-Node Mac, so the owner's line
  // runs the CLI through npx, the same form the Bring your own page shows.
  test('the server CLI form is the Bring your own page CLI_NPX_COMMAND', () => {
    const page = fs.readFileSync(path.resolve(__dirname, '../../../../frontend/src/v2/components/V2AgentBYO.tsx'), 'utf8');
    expect(page).toContain(`const CLI_NPX_COMMAND = '${CLI_NPX_COMMAND}';`);
  });

  test('a second instance\'s command names the instance, which holds its own key (F306)', () => {
    expect(runInstructionFor({ ...seat({ host: 'byo', runtimeType: 'webhook' }), instanceId: 'nova' }))
      .toBe('npx -y @commonlyai/cli@latest agent run echo-bot --instance-id nova');
    expect(runInstructionFor({ ...seat({ runtimeType: 'local-cli' }), instanceId: 'DEFAULT' }))
      .toBe('npx -y @commonlyai/cli@latest agent run echo-bot');
  });

  test('an instance id the CLI would refuse is left out of the command', () => {
    expect(runInstructionFor({ ...seat({ host: 'byo', runtimeType: 'webhook' }), instanceId: 'a b;c' }))
      .toBe('npx -y @commonlyai/cli@latest agent run echo-bot');
  });

  test('a BYO wrapper gets the run command, lowercased', () => {
    expect(runInstructionFor(seat({ host: 'byo', runtimeType: 'webhook' })))
      .toBe('npx -y @commonlyai/cli@latest agent run echo-bot');
  });

  test('a local-cli seat gets the run command', () => {
    expect(runInstructionFor(seat({ runtimeType: 'local-cli' })))
      .toBe('npx -y @commonlyai/cli@latest agent run echo-bot');
  });

  test('a push webhook seat gets no run command, only the webhook instruction', () => {
    const instruction = runInstructionFor(seat({
      runtimeType: 'webhook', webhookUrl: 'https://example.com/hook',
    }));
    expect(instruction).toBe(WEBHOOK_RUN_INSTRUCTION);
    expect(instruction).not.toMatch(/agent run/);
  });

  test('a push webhook stamped host byo still gets the webhook instruction, not a run command', () => {
    const instruction = runInstructionFor(seat({
      runtimeType: 'webhook', host: 'byo', webhookUrl: 'https://example.com/hook',
    }));
    expect(instruction).toBe(WEBHOOK_RUN_INSTRUCTION);
  });

  test('a native seat has no instruction to give', () => {
    expect(runInstructionFor(seat({ runtimeType: 'native' }))).toBeNull();
  });

  test('a gateway seat has no instruction to give', () => {
    expect(runInstructionFor(seat({ runtimeType: 'moltbot' }))).toBeNull();
  });

  test('a legacy webhook row with no host and no URL is BYO, so it keeps the run command', () => {
    expect(classifyRuntime(seat({ runtimeType: 'webhook' })).isByo).toBe(true);
    expect(runInstructionFor(seat({ runtimeType: 'webhook' })))
      .toBe('npx -y @commonlyai/cli@latest agent run echo-bot');
  });

  test('a Mongoose-style config Map is not read here; callers pass a plain object', () => {
    // install.ts normalises the Map before calling. A raw Map has no .runtime.
    const raw = { agentName: 'echo-bot', config: new Map([['runtime', { host: 'byo' }]]) };
    expect(runInstructionFor(raw)).toBeNull();
  });
});
