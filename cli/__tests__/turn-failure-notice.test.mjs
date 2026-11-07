import { adapterFailure } from '../src/lib/upstream-refusal.js';
import { classifySpawnFailure, SPAWN_FAILURE_CLASS } from '../src/lib/spawn-retry.js';
import { PUBLIC_MCP_NOT_READY_CODE, PUBLIC_TOOL_FAILED_CODE } from '../src/lib/public-tool-error.js';
import { publicCodexVersionError } from '../src/lib/adapters/tested-version.js';
import { claudeFailureTail } from '../src/lib/adapters/claude.js';
import {
  LOGIN_NOTICE,
  OUT_OF_ALLOWANCE_NOTICE,
  WONT_START_NOTICE,
  cantAnswerNotice,
  codexVersionNotice,
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

  // The vendors' own text, not a guess at it (F235). Sources are in the comment
  // on OUT_OF_ALLOWANCE_WORDINGS. An API key's owner is whoever runs the seat, so
  // the allowance line's "whoever runs me needs to add more" is the right fix.
  describe('an API key out of credit, in the vendors\' published wordings', () => {
    const OPENAI_SENTENCE = 'You exceeded your current quota, please check your plan and billing details.';
    const ANTHROPIC_SENTENCE = 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.';
    const openaiBody = JSON.stringify({ error: { message: OPENAI_SENTENCE, type: 'insufficient_quota', param: null, code: 'insufficient_quota' } });
    const anthropicBody = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: ANTHROPIC_SENTENCE }, request_id: 'req_1' });

    test.each([
      ['OpenAI\'s sentence, a body the reader reduced', adapterFailure('pi', `429: ${openaiBody}`, { exitCode: 1 })],
      ['OpenAI\'s sentence, on a refused route', new Error(`upstream refused 429: ${OPENAI_SENTENCE}`)],
      ['the Codex CLI\'s rewording, which every billing code becomes', adapterFailure('codex turn failed', 'Quota exceeded. Check your plan and billing details.')],
      ['the type in a body kept whole', new Error('codex turn failed (upstream 429): unexpected status 429: {"error":{"message":"no","type":"insufficient_quota"}}')],
      ['the code in a body kept whole', new Error('codex turn failed (upstream 429): unexpected status 429: {"error":{"message":"no","code":"credit_balance_exhausted"}}')],
      ['the type before a reason phrase', new Error('codex turn failed (upstream 429): unexpected status 429 Too Many Requests: {"error":{"type":"insufficient_quota"}}')],
      ['a compact task, as codex wraps one', new Error('codex turn failed: Error running remote compact task: Quota exceeded. Check your plan and billing details.')],
      ['the code after a status', new Error('codex exited with code 1: 429 insufficient_quota')],
      ['the code leading the text', new Error('opencode turn failed: credit_balance_exhausted: add credits')],
      ['the code in a Python client\'s repr', new Error("Hermes exited with code 1: Error code: 429 - {'error': {'message': 'no', 'code': 'insufficient_quota'}}")],
      ['a compact task that kept its status', new Error('codex turn failed: Error running remote compact task: unexpected status 429: Quota exceeded. Check your plan and billing details.')],
      ['goose', new Error('goose exited with code 1: Credit balance is too low')],
      ['qwen', new Error('qwen exited with code 1: insufficient_quota')],
      ['dsh', new Error('dsh exited with code 1: insufficient_quota')],
      ['pi, in its own exit line', new Error('pi exited 1: Your credit balance is too low to access the Anthropic API.')],
      ['Anthropic\'s sentence, a body the reader reduced', adapterFailure('claude', `400: ${anthropicBody}`, { exitCode: 1 })],
      ['Anthropic\'s sentence, a bare body', adapterFailure('claude', anthropicBody, { exitCode: 1 })],
      ['Anthropic\'s sentence, on a refused route', new Error(`upstream refused 400: ${ANTHROPIC_SENTENCE}`)],
      ['Anthropic\'s sentence, as claude prints a body', new Error(`claude exited with code 1: API Error: 400 ${anthropicBody}`)],
      ['Claude Code, the errors page', new Error('claude exited with code 1: Credit balance is too low')],
      ['Claude Code, the credits page', new Error('claude exited with code 1: Credit balance too low · Add funds: https://platform.claude.com/settings/billing')],
      ['Claude Code, after a stderr line', new Error('claude exited with code 1: ⚠ a warning | Credit balance is too low')],
      ['Claude Code, a failed turn at exit 0', adapterFailure('claude', 'Credit balance is too low')],
      ['Claude Code, before a stdout line', new Error('claude exited with code 1: Credit balance is too low | a stdout line')],
      ['Claude Code, before a second line', new Error('claude exited with code 1: Credit balance is too low\nsecond line')],
      ['Claude Code, before a crashed turn\'s tail', new Error('claude exited with code 1: Credit balance is too low\n{"type":"assistant","text":"hi"}')],
      ['Codex\'s rewording, after stderr', new Error('codex exited with code 1: a warning | Quota exceeded. Check your plan and billing details.')],
      ['the code after stderr', new Error('codex exited with code 1: a warning | insufficient_quota')],
      ['the code after a label', new Error('codex turn failed: insufficient_quota')],
    ])('%s', (_name, error) => {
      expect(classifySpawnFailure(error)).toBe(SPAWN_FAILURE_CLASS.QUOTA);
      expect(cantAnswerNotice(error)?.text).toBe(OUT_OF_ALLOWANCE_NOTICE);
    });

    // A failed turn's stderr is in the message, and it can hold anything a seat
    // working on billing code printed. Only the adapter's own label or the
    // stderr | stdout join opens a wording. Each stays QUOTA for its backoff.
    test.each([
      ['a code named in passing', 'claude exited with code 1: the test expects insufficient_quota here'],
      ['a code a test compared', 'claude exited with code 1: assert code == "insufficient_quota"'],
      ['a test name after a transport', 'codex turn failed: unexpected status 429: FAIL a.js: Credit balance is too low'],
      ['a longer identifier in a body', 'codex turn failed: unexpected status 429: {"error":{"code":"insufficient_quota_x"}}'],
      ['a code beside the error object', 'codex turn failed: unexpected status 429: {"error":{"message":"no"},"metadata":{"code":"insufficient_quota"}}'],
      ['a body that ended before the code', 'codex turn failed: unexpected status 429: {"error":{"code":"x"}}\n"code":"insufficient_quota"'],
      ['another key in a body shape', 'codex turn failed: unexpected status 429: {"error":{"name":"insufficient_quota"}}'],
      ['a longer identifier', 'claude exited with code 1: 429 insufficient_quota_handler failed'],
      ['the credit words in a sentence', 'claude exited with code 1: warn when the credit balance is too low'],
      ['the Claude Code words mid-sentence', 'claude exited with code 1: show Credit balance is too low in the banner'],
      ['the Claude Code words closing a sentence', 'claude exited with code 1: show Credit balance is too low'],
      ['the Claude Code words as another identifier', 'claude exited with code 1: Credit balance is too lowercase'],
      ['Anthropic\'s billing type, which names no empty balance', 'claude exited with code 1: API Error: 402 billing_error'],
      ['a bare quota word', 'codex turn failed: quota exceeded'],
      ['an assertion', 'claude exited with code 1: AssertionError: insufficient_quota'],
      ['a test comparing a status', 'claude exited with code 1: expected 429 insufficient_quota, got 200'],
      ['a test name', 'claude exited with code 1: FAIL billing.test.js: Credit balance is too low'],
      ['a fixture', 'claude exited with code 1: fixture {"error":{"code":"insufficient_quota"}}'],
      ['a body shape after a test name', 'claude exited with code 1: FAIL a.js: {"error":{"code":"insufficient_quota"}}'],
      ['a mock', 'claude exited with code 1: error: Quota exceeded. Check your plan and billing details (mock)'],
      ['the OpenAI sentence after a test name', 'claude exited with code 1: FAIL a.js: You exceeded your current quota, please check your plan and billing details.'],
      ['the Anthropic sentence after a test name', 'claude exited with code 1: FAIL a.js: Your credit balance is too low to access the Anthropic API.'],
      ['a model\'s words', 'claude exited with code 1: Here is the banner text: Credit balance is too low'],
      ['a line with no adapter label', 'AssertionError: insufficient_quota'],
      ['a label inside a line', 'claude exited with code 1: see claude: Credit balance is too low'],
      ['a body with the code outside its error object', 'claude exited with code 1: 429 {"code":"insufficient_quota"}'],
      ['the Codex sentence, lower case', 'codex turn failed: quota exceeded. check your plan and billing details.'],
      ['the Codex sentence mid-sentence', 'claude exited with code 1: print Quota exceeded. Check your plan and billing details.'],
      ['the OpenAI sentence, lower case', 'codex turn failed: you exceeded your current quota, please check your plan and billing details'],
      ['the Anthropic sentence, lower case', 'claude exited with code 1: your credit balance is too low to access the anthropic api'],
      ['the Claude Code words, lower case', 'claude exited with code 1: credit balance is too low'],
      ['a code in capitals', 'codex turn failed: INSUFFICIENT_QUOTA'],
    ])('%s posts nothing and keeps its backoff', (_name, message) => {
      expect(classifySpawnFailure(new Error(message))).toBe(SPAWN_FAILURE_CLASS.QUOTA);
      expect(cantAnswerNotice(new Error(message))).toBeNull();
    });

    describe.each([
      ['insufficient_quota', '429 insufficient_quota'],
      ['credit_balance_exhausted', '429 credit_balance_exhausted'],
      ['the OpenAI sentence', OPENAI_SENTENCE],
      ['the Codex sentence', 'Quota exceeded. Check your plan and billing details.'],
      ['the Anthropic sentence', ANTHROPIC_SENTENCE],
      ['the Claude Code wording', 'Credit balance is too low'],
    ])('a tool result quoting %s', (_name, words) => {
      const toolResult = JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: `HTTP 429: ${words}` }] },
      });

      test.each([
        ['with nothing on stderr', `claude exited with code 1: ${toolResult}`],
        ['after a plain first line', `claude exited with code 1: warn\n${toolResult}`],
        ['after stderr', `claude exited with code 1: warn | ${toolResult}`],
      ])('posts nothing %s', (_where, message) => {
        expect(cantAnswerNotice(new Error(message))).toBeNull();
      });

      test('posts nothing from a public seat, whose withheld turn quotes the tool', () => {
        const error = Object.assign(new Error(`public seat withheld this turn's reply: ${words}`), { code: PUBLIC_TOOL_FAILED_CODE });
        expect(cantAnswerNotice(error)).toBeNull();
      });
    });
  });

  // F235: a crashed turn's stream goes through the real tail and the real
  // adapterFailure. A tool result can carry `| 429: ` inside its JSON, and the
  // status scan used to cut the body there, past the `{"type":` the notice cuts on.
  describe('a crashed claude turn whose tool output carries the words', () => {
    const toolLine = (content) => JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content }] },
    });
    const assistantLine = (text) => JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text }] },
    });
    const crashed = ({ stderr = '', stdout }) => adapterFailure(
      'claude',
      [stderr, claudeFailureTail(stdout)].filter(Boolean).join(' | '),
      { exitCode: 1 },
    );

    describe.each([
      ['the OpenAI sentence', 'req_1 | 429: You exceeded your current quota, please check your plan and billing details.'],
      ['the Anthropic sentence', 'req_1 | 400: Your credit balance is too low to access the Anthropic API'],
      ['the code', 'req_1 | 429: insufficient_quota'],
      ['a 402', 'req_1 | 402: Credit balance is too low'],
      ['the older out of credits', 'req_1 | 429: Your workspace is out of credits.'],
      ['the gateway budget', 'req_1 | 422: Budget has been exceeded!'],
      ['the possessive limit', "req_1 | 429: You've hit your weekly limit"],
    ])('%s', (_name, words) => {
      test.each([
        ['with no result event', () => ({ stdout: toolLine(words) })],
        ['after an assistant line', () => ({ stdout: [assistantLine('checking'), toolLine(words)].join('\n') })],
        ['in the assistant line', () => ({ stdout: assistantLine(words) })],
        ['with an error_max_turns result and no text', () => ({
          stdout: [toolLine(words), '{"type":"result","subtype":"error_max_turns","is_error":true}'].join('\n'),
        })],
        ['after stderr', () => ({ stderr: 'a warning', stdout: toolLine(words) })],
        ['on a line the crash tore', () => ({ stdout: toolLine(words).slice(0, -6) })],
        ['in a result that was not an error', () => ({
          stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: words }),
        })],
      ])('posts nothing and names no status %s', (_where, shape) => {
        const error = crashed(shape());
        expect(error.status).toBeUndefined();
        expect(cantAnswerNotice(error)).toBeNull();
      });
    });

    test('a result flagged is_error at a non-zero exit is the CLI\'s own text, and posts', () => {
      const stdout = '{"type":"result","subtype":"success","is_error":true,"result":"Credit balance is too low"}';
      expect(cantAnswerNotice(crashed({ stdout }))?.text).toBe(OUT_OF_ALLOWANCE_NOTICE);
    });

    test('a finished answer that opens with the words, at a non-zero exit, posts nothing', () => {
      const stdout = '{"type":"result","subtype":"success","is_error":false,"result":"Credit balance is too low"}';
      expect(cantAnswerNotice(crashed({ stdout }))).toBeNull();
    });
  });

  // A code only the keep-list saw. providerCode can come from a tool's JSON, so
  // neither the class nor the line reads it.
  test('credit_balance_exhausted in a reduced body stays a throttle, with no line', () => {
    const error = adapterFailure('codex turn failed', '429: {"error":{"message":"x","code":"credit_balance_exhausted"}}');
    expect(error.providerCode).toBe('credit_balance_exhausted');
    expect(classifySpawnFailure(error)).toBe(SPAWN_FAILURE_CLASS.RATE_LIMIT);
    expect(cantAnswerNotice(error)).toBeNull();
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

  // The login wordings have no class gate, so the code check is all that stands
  // between a tool's quoted refusal and a statement about this seat's key.
  test.each([
    ['failed', PUBLIC_TOOL_FAILED_CODE],
    ['not ready', PUBLIC_MCP_NOT_READY_CODE],
  ])('a public seat quoting a tool\'s error, MCP %s, is not reporting its own key', (_name, code) => {
    const message = 'public seat withheld this turn\'s reply: tool failed (x: Not logged in · Please run /login)';
    expect(cantAnswerNotice(new Error(message))?.cause).toBe('login');
    expect(cantAnswerNotice(Object.assign(new Error(message), { code }))).toBeNull();
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

  describe('a public seat refused for its Codex version', () => {
    test.each([
      ['an older version', '0.149.1'],
      ['a version it could not read', null],
    ])('%s tells the pod what whoever runs it should do', (_name, found) => {
      const notice = cantAnswerNotice(publicCodexVersionError({ found, required: '0.159.3' }));
      expect(notice.cause).toBe('codex-version');
      expect(notice.text).toBe(codexVersionNotice('0.159.3'));
      expect(notice.text).toContain('Codex 0.159.3 or newer');
      expect(notice.text).toContain('upgrade');
    });

    test('the pod is not told which version the host runs', () => {
      const { text } = cantAnswerNotice(publicCodexVersionError({ found: '0.149.1', required: '0.159.3' }));
      expect(text).not.toContain('0.149.1');
    });

    test('the code decides, so a look-alike error tells nobody', () => {
      expect(cantAnswerNotice(new Error('Upgrade Codex to at least 0.159.3'))).toBeNull();
    });
  });

  test('every line fits one chat message and says what to do', () => {
    [LOGIN_NOTICE, WONT_START_NOTICE, OUT_OF_ALLOWANCE_NOTICE, codexVersionNotice('0.159.3')].forEach((line) => {
      expect(line.length).toBeLessThanOrEqual(400);
      expect(line).toMatch(/^I can’t answer right now: /);
      expect(line).toContain('your message again');
    });
  });
});
