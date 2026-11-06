import { adapterFailure } from '../src/lib/upstream-refusal.js';
import { PUBLIC_TOOL_FAILED_CODE } from '../src/lib/public-tool-error.js';
import {
  LOGIN_NOTICE,
  OUT_OF_ALLOWANCE_NOTICE,
  WONT_START_NOTICE,
  cantAnswerNotice,
} from '../src/lib/turn-failure-notice.js';

const causeOf = (error) => cantAnswerNotice(error)?.cause ?? null;

describe('cantAnswerNotice', () => {
  describe('a key or login that failed, in wordings seats have logged', () => {
    test.each([
      ['an expired gateway key, walked on prod', adapterFailure('codex turn failed', 'unexpected status 401 Unauthorized: Authentication Error - Expired Key. Key Expiry time 2026-11-06')],
      ['a missing bearer', adapterFailure('codex turn failed', 'Error running remote compact task: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header')],
      ['a ChatGPT workspace', new Error('codex turn failed: workspace routing discovery unauthorized (401)')],
      ['a claude login', new Error('claude exited with code 1: Not logged in · Please run /login')],
      ['a claude login after a stderr line', new Error('claude exited with code 1: ⚠ connectors are disabled | Not logged in · Please run /login')],
      ['an unscoped key', new Error('claude exited with code 1: x | API Error: 400 This API key is not scoped to a workspace')],
      ['pi with a status it printed', new Error('pi exited 1: 401 {"error":"unauthorized"}')],
      ['pi with a refused route', new Error('upstream refused 401: invalid key')],
      ['a login the wrapper refused', new Error('the Claude login on this machine expires in 3 min, before this turn could end.')],
    ])('%s', (_name, error) => {
      expect(cantAnswerNotice(error)?.text).toBe(LOGIN_NOTICE);
    });
  });

  test.each([
    ['a seat with no CLI', new Error('spawn claude ENOENT')],
    ['a seat with no provider key', new Error('pi adapter: LITELLM_API_KEY is not set — the seat\'s environment must carry the provider key')],
  ])('%s says it would not start', (_name, error) => {
    expect(cantAnswerNotice(error)?.text).toBe(WONT_START_NOTICE);
  });

  describe('an allowance used up, in wordings seats have logged', () => {
    test.each([
      ['claude, session', "claude exited with code 1: You've hit your session limit · resets 3:00am (America/Los_Angeles)"],
      ['claude, weekly', "claude exited with code 1: You've hit your weekly limit · resets Nov 3 at 5pm (America/Los_Angeles)"],
      ['claude, a curly apostrophe', 'claude exited with code 1: You’ve hit your weekly limit · resets Nov 3 at 5pm'],
      ['claude, behind another message', "claude exited with code 1: Prompt is too long · automatic compaction failed: You've hit your weekly limit · resets Oct 3 at 5pm"],
      ['claude, a model', "claude exited with code 1: You've reached your Fable 5 limit"],
      ['codex, ChatGPT login', "codex turn failed: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:01 PM."],
      ['codex, workspace', 'codex turn failed: Your workspace is out of credits. Add credits to continue.'],
      ['a gateway key, walked on prod', 'codex turn failed (upstream 422): unexpected status 422 Unprocessable Entity: Budget has been exceeded! Key=walk (sk-...abcd) Current cost: 0.0154, Max budget: 5e-05'],
      ['a gateway model group, as our config words it', 'codex turn failed (upstream 429): unexpected status 429: crossed budget'],
      ['pi, on a refused route', 'upstream refused 429: Budget has been exceeded! Current cost: 12.34, Max budget: 10.00'],
    ])('%s', (_name, message) => {
      expect(cantAnswerNotice(new Error(message))?.text).toBe(OUT_OF_ALLOWANCE_NOTICE);
    });
  });

  // Each of these once read as a key or install problem, or could have. Before
  // this line existed a wrong match cost a slower retry. Now it tells a person
  // something untrue.
  test.each([
    ['a panic at line 401', 'codex exited with code 101: thread panicked at src/client.rs:401:12'],
    ['a stack frame at line 401', 'claude exited with code 1: at run (/app/dist/a.js:401:9)'],
    ['a process id', 'codex exited with code 137: killed process 401'],
    ['a server error that mentions one', 'codex turn failed (upstream 503): last status 401'],
    ['a route that wants a login', 'request failed with status 403: Authentication required for this route'],
    ['a tool that is missing', 'claude exited with code 1: gh: command not found'],
    ['a file that is missing', "claude exited with code 1: ENOENT: no such file or directory, open '/x/y/config.toml'"],
    ['the model saying it', 'claude exited with code 1: The upstream returned 401 Unauthorized earlier'],
    ['a rate limit', 'unexpected status 429 Too Many Requests'],
    ['a rate limit worded as possessive', "you've hit your rate limit"],
    ['a word that only sets a backoff', 'claude exited with code 1: see the billing module'],
    ['a prompt that is too long', 'claude exited with code 1: Prompt is too long'],
    ['a crash', 'codex exited with code 1:'],
    ['a bare 403', 'request failed with status 403'],
  ])('%s posts nothing', (_name, message) => {
    expect(cantAnswerNotice(new Error(message))).toBeNull();
  });

  // Through the real adapterFailure, which labels any "status 401" it finds.
  test.each([
    ['a tool the agent ran', 'codex', 'gh: HTTP 401: Bad credentials'],
    ['curl', 'codex', 'curl: request failed, status 401'],
    ['an MCP server', 'claude', '[mcp commonly] status: 401 on tools/list'],
    ['the model, on a crashed turn', 'claude', 'the request came back with status 401'],
    ['a diff stat', 'claude', '401 files changed'],
  ])('%s posts nothing', (_name, label, tail) => {
    expect(cantAnswerNotice(adapterFailure(label, tail, { exitCode: 1 }))).toBeNull();
  });

  test('the model quoting a failure in a crashed turn\'s tail posts nothing', () => {
    const tail = '{"type":"assistant","text":"Not logged in · Please run /login, and You\'ve hit your weekly limit"}';
    expect(cantAnswerNotice(new Error(`claude exited with code 1: warning | ${tail}`))).toBeNull();
  });

  test.each([
    ['with nothing on stderr', 'claude exited with code 1: {"type":"assistant","text":"out of credits"}'],
    ['after a plain first line', 'claude exited with code 1: warn\n{"type":"assistant","text":"Budget has been exceeded!"}'],
    ['after stderr', 'claude exited with code 1: warn | {"type":"user","text":"refusing a Claude login"}'],
  ])('a crashed turn\'s JSON tail posts nothing %s', (_name, message) => {
    expect(cantAnswerNotice(new Error(message))).toBeNull();
  });

  test('a budget in another sense posts nothing and keeps its backoff', () => {
    expect(cantAnswerNotice(new Error('codex turn failed: thinking budget has been exceeded'))).toBeNull();
  });

  test('a 401 is a 401, whatever else its body says', () => {
    expect(causeOf(adapterFailure('codex turn failed', 'unexpected status 401: quota and billing are fine'))).toBe('login');
  });

  test('a public seat quoting a tool\'s error is not reporting its own key', () => {
    const error = Object.assign(new Error('(upstream 401) Not logged in · Please run /login'), { code: PUBLIC_TOOL_FAILED_CODE });
    expect(cantAnswerNotice(error)).toBeNull();
  });

  test('the line never quotes the error, which can carry key material', () => {
    const { text } = cantAnswerNotice(adapterFailure('codex turn failed', 'unexpected status 401 Expired Key sk-walk-abc123'));
    expect(text).not.toContain('sk-');
    expect(text).not.toContain('401');
  });

  test('a budget refusal keeps its key, its alias and its numbers out of the pod', () => {
    const { text } = cantAnswerNotice(new Error('codex turn failed (upstream 422): Budget has been exceeded! Key=walk-budget (sk-...abcd) Current cost: 0.0154, Max budget: 5e-05'));
    ['sk-', 'walk-budget', '0.0154', 'Max budget'].forEach((leak) => expect(text).not.toContain(leak));
  });

  test('every line fits one chat message and says what to do', () => {
    [LOGIN_NOTICE, WONT_START_NOTICE, OUT_OF_ALLOWANCE_NOTICE].forEach((line) => {
      expect(line.length).toBeLessThanOrEqual(400);
      expect(line).toMatch(/^I can’t answer right now: /);
      expect(line).toContain('your message again');
    });
  });
});
