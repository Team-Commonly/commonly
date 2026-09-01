// TASK-074. The SOUL footer's "Use of NO_REPLY" passage asserts a kernel
// mechanism to a reader who cannot falsify it: an agent acts on the passage
// and has no view of `sanitizeAgentContent`. Nothing guarded that the passage
// stays true, so the sanitizer could change and the copy would go silently
// wrong — which is exactly how the passage came to be false before #1354
// (it said a fenced sentinel is "preserved verbatim"; a fenced sentinel-only
// reply is suppressed, and a fence is stripped from storage either way).
//
// So these tests pin the BEHAVIOUR each documented case promises, not the
// wording that promises it. If the sanitizer's position rules move, this file
// reddens and names the passage that must move with it.
const fs = require('fs');
const path = require('path');
const AgentMessageService = require('../../../services/agentMessageService');

const PROVISIONER_SOURCE = path.join(
  __dirname, '..', '..', '..', 'services', 'agentProvisionerServiceK8s.ts',
);

// The passage ships as data inside a template literal, so reading the source
// here is reading the artifact, not asserting that a code path executes.
const readSentinelPassage = () => {
  const source = fs.readFileSync(PROVISIONER_SOURCE, 'utf8');
  const start = source.indexOf('### Use of NO_REPLY');
  expect(start).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const end = rest.search(/\n###\s|\n`;/);
  return rest.slice(0, end === -1 ? undefined : end);
};

const sanitize = (input) => AgentMessageService.sanitizeAgentContent(input);

describe('SOUL footer — the NO_REPLY passage matches the sanitizer', () => {
  it('documents exactly the cases the tests below cover', () => {
    // A budget, not a copy assertion: adding a fifth case to the passage
    // without a behavioural pin for it reddens here rather than shipping an
    // unguarded promise. Rewording any existing bullet does not.
    const bullets = readSentinelPassage()
      .split('\n')
      .filter((line) => line.startsWith('- **'));
    expect(bullets).toHaveLength(4);
  });

  it('case 1 — a leading bare sentinel suppresses the WHOLE reply', () => {
    expect(sanitize('NO_REPLY')).toBe('');
    expect(sanitize('NO_REPLY\nHere is the real answer.')).toBe('');
  });

  it('case 2 — a bare sentinel anywhere else is stripped and the rest POSTS', () => {
    expect(sanitize('Shipped the fix.\nNO_REPLY')).toBe('Shipped the fix.');
    expect(sanitize('Reply with NO_REPLY when done.')).toBe('Reply with  when done.');
  });

  it('case 3 — backticks keep the token, INCLUDING as the entire reply', () => {
    expect(sanitize('Reply with `NO_REPLY` when done.'))
      .toBe('Reply with `NO_REPLY` when done.');
    // The half that makes case 3 and case 4 different bullets rather than one:
    // an inline-backticked sentinel-only reply posts that literal.
    expect(sanitize('`NO_REPLY`')).toBe('`NO_REPLY`');
    expect(sanitize('``NO_REPLY``')).toBe('``NO_REPLY``');
  });

  it('case 4 — a fence keeps the token, drops the fence, and stays silent alone', () => {
    expect(sanitize('```text\nNO_REPLY is discussed here.\n```'))
      .toBe('NO_REPLY is discussed here.');
    expect(sanitize('```text\nNO_REPLY\n```')).toBe('');
    expect(sanitize('```\nNO_REPLY\n```')).toBe('');
  });
});
