// D164: what the Windows Bring-your-own walk (cli/scripts/windows-byo-smoke.mjs)
// fails on. On a pull request the published leg is mostly reported, because a
// CLI fix reaches npm only after it merges. But this tree's leg replaces the
// page's install line, so it cannot stand in for that line: a page that names
// a package npm cannot install must fail the PR, not warn.

import {
  describeCause, INSTALL_GUARD, installExitFrom, parseRecorderLog,
  pasteScript, prodInputs, prodOutcome, publishedOutcome, redact,
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
});

// D250: a Codex seat reaches claude-haiku-5-5 through the gateway's Responses
// bridge, which no walk had run before. So a failed walk says whose failure it
// was: the model route (the gateway or model refused), the harness (the turn
// failed with no model refusal), or Commonly (the turn never failed, but the
// reply or the ack did not happen).
describe('the prod verdict names whose failure it was', () => {
  const READY = Date.parse('2026-11-05T03:00:00Z');
  const at = (s) => new Date(READY + s * 1000).toISOString();
  const mention = { id: '300', self: false, username: 'lily-shen', createdAt: at(20), content: '@codex-walk reply with the word codex-ok' };
  const reply = { id: '301', self: true, username: 'codex-walk', createdAt: at(45), content: 'codex-ok' };
  const event = { kind: 'event', eventId: 'e3', type: 'chat.mention', podId: 'p1', messageId: '300' };
  const ack = { kind: 'ack', eventId: 'e3', status: 200, outcome: 'posted' };
  const base = { agentName: 'codex-walk', readyAt: READY, events: [event] };
  const failedTurn = (failureClass, message) => `2026-11-05T03:00:30Z [codex-walk] chat.mention processing failed (${failureClass}; 1 consecutive) `
    + `— event e3 unacked; next poll in 30s: ${message}\n`;

  test('a pass names no cause, and neither does a walk nobody has posted in yet', () => {
    expect(prodOutcome({ ...base, messages: [mention, reply], acks: [ack] })).toMatchObject({ passed: true, cause: null });
    expect(prodOutcome({ ...base, messages: [], acks: [] })).toMatchObject({ passed: false, cause: null });
  });

  test('a content refusal the CLI acked is the model route, and its notice in the pod is not a reply', () => {
    const outcome = prodOutcome({
      ...base, messages: [mention, reply], acks: [{ ...ack, outcome: 'no_action', reason: 'provider-refused' }],
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.cause).toBe('model');
    expect(outcome.problems[0]).toMatch(/model provider refused the @mention's content/);
  });

  test('an upstream refusal the CLI acked with its status is the model route', () => {
    const outcome = prodOutcome({
      ...base, messages: [mention], acks: [{ ...ack, outcome: 'no_action', reason: 'upstream-refused-401', refusedStatus: 401 }],
    });
    expect(outcome.cause).toBe('model');
    expect(outcome.problems[0]).toMatch(/gateway or model refused the turn \(upstream 401\)/);
  });

  test('an unacked turn the model refused is the model route, read from the CLI\'s log', () => {
    const outcome = prodOutcome({
      ...base, messages: [mention], acks: [],
      output: failedTurn('configuration', 'codex turn failed (upstream 400): model claude-haiku-5-5 is not allowed'),
    });
    expect(outcome.cause).toBe('model');
    expect(outcome.problems[0]).toMatch(/gateway or model refused the turn \(configuration, upstream 400\)/);
    expect(outcome.problems).toContain('the @mention was never acknowledged');
    // The failure's own text stays in the dump; the verdict names only its class and status.
    expect(outcome.problems.join('\n')).not.toMatch(/not allowed/);
  });

  // provider-proxy.js writes two refusals. An unpinned model is the model
  // route's; a route the proxy doesn't serve is a mismatch between this codex
  // and the CLI's provider route, which no gateway or model caused.
  // The CLI's output covers the whole run, so a turn that failed before the
  // person's @mention was another event's, and is not this mention's cause.
  test('a failure logged before the @mention is not blamed on it', () => {
    const earlier = '2026-11-05T03:00:10.000Z [codex-walk] inbox batch processing failed (rate_limit; 1 consecutive) '
      + '— retrying 1 held event in 5.9s: codex turn failed (upstream 429)\n';
    expect(prodOutcome({ ...base, messages: [mention], acks: [], output: earlier }).cause).toBe('unfinished');
    expect(prodOutcome({ ...base, messages: [mention], acks: [], output: earlier + failedTurn('runtime', 'codex: exited 1') }).cause)
      .toBe('harness');
  });

  // The proxy writes its refusals unstamped, so a refusal takes the time of the
  // CLI line before it: one under an earlier line was another event's.
  test('an unstamped proxy refusal under a line from before the @mention is not blamed on it', () => {
    const before = '2026-11-05T03:00:10.000Z [codex-walk] [inbox.batch] spawning codex\n'
      + '[codex] provider proxy refused a completion for an unpinned model\n';
    const after = '2026-11-05T03:00:25.000Z [codex-walk] [inbox.batch] spawning codex\n'
      + '[codex] provider proxy refused a completion for an unpinned model\n';
    expect(prodOutcome({ ...base, messages: [mention], acks: [], output: before }).cause).toBe('unfinished');
    expect(prodOutcome({ ...base, messages: [mention], acks: [], output: before + after }).cause).toBe('model');
    // With no CLI line before it, nothing places a refusal, so it still counts.
    expect(prodOutcome({ ...base, messages: [mention], acks: [], output: '[codex] provider proxy refused POST /v1/x\n' }).cause)
      .toBe('harness');
  });

  test('the host proxy refusing an unpinned model is the model route', () => {
    const outcome = prodOutcome({
      ...base, messages: [mention], acks: [],
      output: '[codex] provider proxy refused a completion for an unpinned model\n',
    });
    expect(outcome.cause).toBe('model');
  });

  test('the host proxy refusing a route codex called is the harness, named as a route mismatch', () => {
    const outcome = prodOutcome({
      ...base, messages: [mention], acks: [],
      output: '[codex] provider proxy refused POST /v1/chat/completions\n',
    });
    expect(outcome.cause).toBe('harness');
    expect(outcome.problems[0])
      .toBe("the CLI's provider proxy refused a route the harness called: a mismatch between the harness and the CLI's provider route, not the gateway or the model");
  });

  test('a configuration failure with no upstream status is the harness: a missing binary or login', () => {
    const outcome = prodOutcome({
      ...base, messages: [mention], acks: [],
      output: failedTurn('configuration', 'codex: spawn codex ENOENT'),
    });
    expect(outcome.cause).toBe('harness');
    expect(prodOutcome({ ...base, messages: [mention], acks: [], output: failedTurn('configuration', 'codex: not logged in') }).cause)
      .toBe('harness');
  });

  // CONFIGURATION_RE (cli/src/lib/spawn-retry.js) also classes a rejected key
  // as configuration, with no upstream status on the line. That is most likely
  // the model route's answer, not a missing binary or login.
  test('a configuration failure that names a rejected key is the model route, though it carries no status', () => {
    for (const text of [
      'codex: invalid API key', 'codex: authentication failed', 'codex turn failed: 401 Unauthorized', 'gateway said Forbidden',
    ]) {
      const outcome = prodOutcome({ ...base, messages: [mention], acks: [], output: failedTurn('configuration', text) });
      expect({ text, cause: outcome.cause }).toEqual({ text, cause: 'model' });
      expect(outcome.problems[0]).toMatch(/failed as configuration with no upstream status: most likely the model route/);
    }
  });

  test('an upstream refusal acked with no status says so, not "upstream undefined"', () => {
    const outcome = prodOutcome({
      ...base, messages: [mention], acks: [{ ...ack, outcome: 'no_action', reason: 'upstream-refused-undefined' }],
    });
    expect(outcome.cause).toBe('model');
    expect(outcome.problems[0]).toMatch(/\(upstream status unknown\)/);
    expect(prodOutcome({
      ...base, messages: [mention], acks: [{ ...ack, outcome: 'no_action', reason: 'upstream-refused-502' }],
    }).problems[0]).toMatch(/\(upstream 502\)/);
  });

  test('a turn that failed with no model refusal is the harness', () => {
    const outcome = prodOutcome({
      ...base, messages: [mention], acks: [],
      output: failedTurn('runtime', 'codex: windows sandbox setup failed'),
    });
    expect(outcome.cause).toBe('harness');
    expect(outcome.problems[0]).toMatch(/the agent's turn failed \(runtime\) without a model refusal/);
  });

  test('the log line names each cause in words, and none for a pass', () => {
    expect(describeCause('model', 'Codex')).toMatch(/model route failed/);
    expect(describeCause('harness', 'Codex')).toMatch(/^verdict: Codex's turn failed without a model refusal/);
    expect(describeCause('commonly', 'Codex')).toMatch(/Commonly's delivery/);
    expect(describeCause(null)).toBeNull();
  });

  test('an @mention the CLI was never handed is Commonly\'s delivery, and so is a reply that was never acked', () => {
    expect(prodOutcome({ ...base, messages: [mention], events: [], acks: [], output: 'polling https://api.commonly.me for events\n' }))
      .toMatchObject({ passed: false, cause: 'commonly' });
    expect(prodOutcome({ ...base, messages: [mention, reply], acks: [] }))
      .toMatchObject({ passed: false, cause: 'commonly', problems: ['the @mention was never acknowledged'] });
  });

  // The walk gives up before the adapter's own timeout, so a gateway that
  // accepts /responses and never finishes leaves no failed line at all.
  test('a turn the CLI was handed and never finished blames nobody', () => {
    const outcome = prodOutcome({ ...base, messages: [mention], acks: [], output: 'spawning codex for chat.mention\n' });
    expect(outcome).toMatchObject({ passed: false, cause: 'unfinished' });
    expect(outcome.problems[0]).toMatch(/handed the @mention, but its turn never finished/);
    expect(describeCause('unfinished', 'Codex')).toMatch(/^verdict: Codex was handed the @mention/);
    expect(describeCause('unfinished', 'Codex')).not.toMatch(/Commonly's delivery/);
  });

  // A Commonly API call that throws mid-turn reaches the same line, and nothing
  // in its text marks it, so a line with no upstream status can't say "not Commonly".
  test('a model-class failure with no upstream status does not clear Commonly', () => {
    const outcome = prodOutcome({ ...base, messages: [mention], acks: [], output: failedTurn('rate_limit', 'Too many requests') });
    expect(outcome.cause).toBe('model');
    expect(outcome.problems[0]).toMatch(/rate_limit with no upstream status/);
    expect(outcome.problems[0]).not.toMatch(/not Commonly/);
    expect(describeCause('model', 'Codex')).not.toMatch(/not Commonly/);
  });
});

// D250: each walk runs one harness, named by the dispatch.
