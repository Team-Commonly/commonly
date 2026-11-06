// D164: what the Windows Bring-your-own walk (cli/scripts/windows-byo-smoke.mjs)
// fails on. On a pull request the published leg is mostly reported, because a
// CLI fix reaches npm only after it merges. But this tree's leg replaces the
// page's install line, so it cannot stand in for that line: a page that names
// a package npm cannot install must fail the PR, not warn.

import {
  INSTALL_GUARD, installExitFrom, unconfinedNoticeFrom, parseRecorderLog, pasteScript, prodInputs, prodOutcome, publishedOutcome, redact,
} from '../scripts/windows-byo-verdict.mjs';

const PAGE = [
  'npm i -g @commonlyai/cli@latest',
  '$env:COMMONLY_API_URL="http://127.0.0.1:1"',
  '$env:COMMONLY_AGENT_TOKEN="cm_agent_x"',
  'commonly agent run win-byo --adapter claude --unsandboxed',
];

// What PowerShell prints when the page's install line names a missing package
// and the guard after it trips (npm's own E404 lines, then the guard's).
const BROKEN_INSTALL_OUT = 'npm error code E404\n'
  + 'npm error 404 Not Found - GET https://registry.npmjs.org/@commonlyai%2fclii - Not found\n'
  + 'windows-byo-smoke: the install line exited 1\n';

describe('the pasted script', () => {
  test('stops right after the install line when that line fails', () => {
    const script = pasteScript(PAGE);
    expect(script[0]).toBe(PAGE[0]);
    expect(script[1]).toBe(INSTALL_GUARD);
    expect(script.slice(2)).toEqual(PAGE.slice(1));
    expect(INSTALL_GUARD).toMatch(/\$LASTEXITCODE/);
    expect(INSTALL_GUARD).toMatch(/exit 97/);
  });

  test('the guard\'s line is read back as the install exit code', () => {
    expect(installExitFrom(BROKEN_INSTALL_OUT)).toBe(1);
    expect(installExitFrom('added 12 packages in 4s\n')).toBeNull();
  });
});

describe('the published leg on a pull request', () => {
  const reportOnly = true;

  test('a page install line npm cannot install fails, it is not a warning', () => {
    const out = publishedOutcome({
      problems: ['the agent never polled for its @mention', 'PowerShell exited 97 before the walk finished'],
      installExit: installExitFrom(BROKEN_INSTALL_OUT),
      delivered: false,
    }, { reportOnly });
    expect(out.warn).toEqual([]);
    expect(out.fail).toEqual(expect.arrayContaining([expect.stringMatching(/install line exited 1/)]));
  });

  test('a published CLI that never picks up its @mention fails', () => {
    const out = publishedOutcome({
      problems: ['the agent never polled for its @mention'], installExit: null, delivered: false,
    }, { reportOnly });
    expect(out.warn).toEqual([]);
    expect(out.fail).toEqual(['the agent never polled for its @mention']);
  });

  test('a CLI that got the @mention but did not answer it is reported (the fix ships on merge)', () => {
    const problems = ['Claude Code never reached the model', 'no reply came back to the pod within 41 s'];
    const out = publishedOutcome({ problems, installExit: null, delivered: true }, { reportOnly });
    expect(out).toEqual({ fail: [], warn: problems });
  });
});

describe('dispatched, or this tree\'s leg', () => {
  test('every problem fails', () => {
    const problems = ['no reply came back to the pod within 41 s'];
    expect(publishedOutcome({ problems, installExit: null, delivered: true }, { reportOnly: false }))
      .toEqual({ fail: problems, warn: [] });
  });

  test('a failed install names its exit code first', () => {
    const out = publishedOutcome({ problems: ['the agent never polled for its @mention'], installExit: 1, delivered: false });
    expect(out.fail[0]).toMatch(/install line exited 1/);
  });
});

// The prod mode (target=prod): the page's lines against the live API with a
// real model, and a person in the pod posts the @mention. The walk reads the
// pod with the agent's token and the CLI's own acks, and nothing it logs may
// carry either secret.
describe('the prod walk', () => {
  const READY = Date.parse('2026-11-04T23:00:00Z');
  const at = (s) => new Date(READY + s * 1000).toISOString();
  const mention = { id: '200', self: false, username: 'lily-shen', createdAt: at(20), content: '@win-walk-1104 reply with the word windows-ok' };
  const reply = { id: '201', self: true, username: 'win-walk-1104', createdAt: at(45), content: 'windows-ok' };
  const event = { kind: 'event', eventId: 'e1', type: 'chat.mention', podId: 'p1', messageId: '200' };
  const ack = { kind: 'ack', eventId: 'e1', status: 200 };

  test('takes only well-formed dispatch inputs', () => {
    expect(prodInputs({
      COMMONLY_BYO_PROD_AGENT: 'win-walk-1104', COMMONLY_BYO_PROD_INSTANCE: 'windows-walk', COMMONLY_BYO_PROD_POD: '6aebaf42ced9d6e454902f66',
      COMMONLY_BYO_PROD_AGENT_TOKEN: 'cm_agent_t', COMMONLY_BYO_PROD_LLM_KEY: 'sk-k',
    })).toEqual({
      agentName: 'win-walk-1104', instanceId: 'windows-walk', podId: '6aebaf42ced9d6e454902f66', token: 'cm_agent_t', llmKey: 'sk-k',
    });
    const good = {
      COMMONLY_BYO_PROD_AGENT: 'a', COMMONLY_BYO_PROD_INSTANCE: 'b', COMMONLY_BYO_PROD_POD: '6aebaf42ced9d6e454902f66',
      COMMONLY_BYO_PROD_AGENT_TOKEN: 't', COMMONLY_BYO_PROD_LLM_KEY: 'k',
    };
    // The agent name is pasted into PowerShell, so nothing but a plain name.
    expect(() => prodInputs({ ...good, COMMONLY_BYO_PROD_AGENT: 'a; Remove-Item x' })).toThrow(/agentName/);
    expect(() => prodInputs({ ...good, COMMONLY_BYO_PROD_POD: 'not-a-pod' })).toThrow(/podId/);
    expect(() => prodInputs({ ...good, COMMONLY_BYO_PROD_INSTANCE: '' })).toThrow(/instanceId/);
    expect(() => prodInputs({ ...good, COMMONLY_BYO_PROD_AGENT_TOKEN: '' })).toThrow(/BYO_WIN_PROD_AGENT_TOKEN/);
    expect(() => prodInputs({ ...good, COMMONLY_BYO_PROD_LLM_KEY: '' })).toThrow(/BYO_WIN_PROD_LLM_KEY/);
    // The Linux walk names its own secrets.
    expect(() => prodInputs({ ...good, COMMONLY_BYO_PROD_AGENT_TOKEN: '' }, { secrets: 'BYO_LINUX_PROD' })).toThrow(/BYO_LINUX_PROD_AGENT_TOKEN/);
  });

  test('redacts every secret from what it logs', () => {
    expect(redact('$env:COMMONLY_AGENT_TOKEN="cm_agent_t" and sk-k twice sk-k', ['cm_agent_t', 'sk-k', '']))
      .toBe('$env:COMMONLY_AGENT_TOKEN="***" and *** twice ***');
  });

  test('reads the recorder\'s lines and skips a torn one', () => {
    const text = `${JSON.stringify(event)}\n${JSON.stringify(ack)}\n{"kind":"ack","eve`;
    expect(parseRecorderLog(text)).toEqual({ events: [event], acks: [ack] });
  });

  test('passes on the person\'s @mention, the agent\'s reply after it, and that mention\'s ack', () => {
    const outcome = prodOutcome({
      messages: [reply, mention], agentName: 'win-walk-1104', readyAt: READY, events: [event], acks: [ack],
    });
    expect(outcome.passed).toBe(true);
    expect(outcome.mention.id).toBe('200');
    expect(outcome.reply.id).toBe('201');
    expect(outcome.answerSeconds).toBe(25);
    expect(outcome.problems).toEqual([]);
  });

  test('a reply without the ack, or an ack that failed, is not a pass', () => {
    const base = { messages: [mention, reply], agentName: 'win-walk-1104', readyAt: READY, events: [event] };
    expect(prodOutcome({ ...base, acks: [] }).problems).toEqual(['the @mention was never acknowledged']);
    expect(prodOutcome({ ...base, acks: [{ ...ack, status: 500 }] }).passed).toBe(false);
    // An ack for some other event does not acknowledge this mention.
    expect(prodOutcome({ ...base, acks: [{ ...ack, eventId: 'e9' }] }).passed).toBe(false);
  });

  test('an @mention from before the agent was listening, or the agent\'s own message, is not the mention', () => {
    const early = { ...mention, createdAt: at(-60) };
    expect(prodOutcome({
      messages: [early, reply], agentName: 'win-walk-1104', readyAt: READY, events: [event], acks: [ack],
    }).problems).toContain('no @win-walk-1104 mention from a person yet');
    const own = { ...mention, self: true };
    expect(prodOutcome({
      messages: [own], agentName: 'win-walk-1104', readyAt: READY, events: [], acks: [],
    }).mention).toBeNull();
  });

  test('a reply posted before the mention does not answer it', () => {
    const before = { ...reply, createdAt: at(10) };
    const outcome = prodOutcome({
      messages: [before, mention], agentName: 'win-walk-1104', readyAt: READY, events: [event], acks: [ack],
    });
    expect(outcome.reply).toBeNull();
    expect(outcome.problems).toContain('no reply from the agent after the @mention');
  });

  test('the walk finds the line that says a seat runs unconfined, and reports none when it is absent', () => {
    const line = '[win] unsandboxed (opted in): Windows has no sandbox Codex can use here';
    expect(unconfinedNoticeFrom(`polling\r\n${line}\r\nready\r\n`)).toBe(line);
    expect(unconfinedNoticeFrom('polling\nready\n')).toBeNull();
  });
});
