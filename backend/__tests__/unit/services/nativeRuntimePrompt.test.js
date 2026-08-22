/**
 * The native runtime must use the server-composed cue (#1071, TASK-034).
 *
 * `payload.content` is where every inline cue lives — the pod-context frame,
 * the ADR-012 §9 DM frame, the board-wake task list, the lease warning —
 * because metadata gets deprioritised by the model. The wrapper's
 * `extractPrompt` has always preferred it; this tier did not, and the gap was
 * invisible because both tiers still "ran".
 *
 * These drive the real function rather than asserting on source text. The
 * regression they pin is that `trigger.type` is the RAW event type, so
 * `chat.mention` never matched a branch testing for `'mention'` and every
 * message-shaped wake reached the model with its cue discarded.
 */
const { buildUserMessage } = require('../../../services/nativeRuntimeService');

const POD = 'Sprint Pod';
const boardWakeCue = '[The kernel found unclaimed work in this pod — 1 pending, unassigned:]\n\n- TASK-034 — Native runtime runs on board wakes';

describe('the inline cue reaches the model verbatim', () => {
  it.each([
    ['message.posted (board wake)', 'message.posted'],
    ['chat.mention', 'chat.mention'],
    ['dm.message', 'dm.message'],
    ['thread.mention', 'thread.mention'],
    ['an unknown future type', 'some.new.type'],
  ])('%s — content is the prompt, unmodified', (_label, type) => {
    const out = buildUserMessage({ type, payload: { content: boardWakeCue } }, POD);
    expect(out).toBe(boardWakeCue);
  });

  it('the board-wake task list survives — the whole point of TASK-034', () => {
    const out = buildUserMessage({ type: 'message.posted', payload: { content: boardWakeCue } }, POD);
    expect(out).toContain('TASK-034');
    expect(out).toContain('1 pending, unassigned');
    // The pre-fix fallthrough replaced all of this with a generic instruction.
    expect(out).not.toContain('Use commonly_read_context to understand');
  });

  it.each(['prompt', 'text'])('falls back to payload.%s like the wrapper does', (key) => {
    const out = buildUserMessage({ type: 'message.posted', payload: { [key]: 'do the thing' } }, POD);
    expect(out).toBe('do the thing');
  });
});

describe('content-less events still get something usable', () => {
  it('a mention with no content names the message instead of going generic', () => {
    const out = buildUserMessage(
      { type: 'chat.mention', payload: { username: 'sam', messageId: '56527' } },
      POD,
    );
    expect(out).toContain('sam');
    expect(out).toContain('56527');
    expect(out).toContain(POD);
  });

  it('heartbeat keeps its own prompt when no cue is supplied', () => {
    const out = buildUserMessage({ type: 'heartbeat', payload: {} }, POD);
    expect(out).toContain('heartbeat');
    expect(out).toContain(POD);
  });

  it('whitespace-only content is not a cue', () => {
    const out = buildUserMessage({ type: 'heartbeat', payload: { content: '   \n  ' } }, POD);
    expect(out).toContain('heartbeat');
  });

  it('a genuinely unknown, content-less type still returns a usable instruction', () => {
    const out = buildUserMessage({ type: 'pod.join', payload: {} }, POD);
    expect(out).toContain('pod.join');
    expect(out.length).toBeGreaterThan(20);
  });
});
