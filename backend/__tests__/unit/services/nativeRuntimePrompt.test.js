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

// TASK-779: a hosted turn posts its final text unless that text is exactly
// NO_REPLY (or another silent sentinel), so a heartbeat with nothing to say
// must be told to return it. Triage's 22:28:01Z heartbeat called no post tool
// and its prose posted 10 s later. The scheduler's own cue cannot carry that:
// it is written for seats that read a HEARTBEAT.md file, which a hosted agent
// does not have, and its cycle frame names a tool native turns lack, so the
// native cue rewrite drops it and leaves only the HEARTBEAT.md instruction.
describe('a hosted heartbeat with nothing to post just ends: only the post tool reaches the pod', () => {
  // F190: the final text of a heartbeat is never posted (finalTextReachesPod),
  // so the prompt says the post tool is the only way in, not "return NO_REPLY".
  const HEARTBEAT_POST_LINE = 'Only commonly_post_message reaches the pod: your final text on a heartbeat is never posted';
  const { buildHeartbeatContent } = require('../../../services/heartbeatCue');
  const { nativeCueFromKernel } = require('../../../services/nativeKernelCue');
  const { NATIVE_TOOL_NAMES } = require('../../../services/nativeRuntimeService');

  it('a content-less heartbeat names the post tool as the only way into the pod', () => {
    const out = buildUserMessage({ type: 'heartbeat', payload: {} }, POD);
    expect(out).toContain(HEARTBEAT_POST_LINE);
    expect(out).not.toContain('Otherwise do nothing');
  });

  it('the scheduler\'s heartbeat, as a native turn reads it, names the post tool and no HEARTBEAT.md', () => {
    const podId = '6aeb8bc75a12e3e23872e765';
    const out = nativeCueFromKernel(
      buildUserMessage({ type: 'heartbeat', payload: { content: buildHeartbeatContent(podId) } }, POD),
      podId,
      NATIVE_TOOL_NAMES,
    );
    expect(out).toContain(HEARTBEAT_POST_LINE);
    expect(out).toContain(POD);
    expect(out).not.toContain('HEARTBEAT.md');
    expect(out).not.toContain('HEARTBEAT_OK');
    expect(out).not.toContain('commonly_log_cycle');
  });

  // The digest rides in a heartbeat's content too: runWithDigest appends the
  // unread summary to any native event's payload.content, and the unread-
  // digest heartbeat is only that. Both are marked read after a successful
  // turn, so a heartbeat prompt that drops its content hides them for good.
  const digestSummary = '[Unread since your last turn: 3 messages in thread 129000, 1 in the main channel.]';

  it('keeps the digest the scheduled heartbeat carries, and still names the post tool', () => {
    const podId = '6aeb8bc75a12e3e23872e765';
    const content = `${buildHeartbeatContent(podId)}\n\n${digestSummary}`;
    const out = nativeCueFromKernel(buildUserMessage({ type: 'heartbeat', payload: { content } }, POD), podId, NATIVE_TOOL_NAMES);
    expect(out).toContain(digestSummary);
    expect(out).toContain(HEARTBEAT_POST_LINE);
    expect(out).not.toContain('HEARTBEAT.md');
  });

  it('keeps the unread-digest heartbeat\'s own frame and its digest, and names the post tool', () => {
    const frame = '[Unread pod activity is waiting. Read the digest in this inbox batch; respond only if useful.]';
    const out = nativeCueFromKernel(
      buildUserMessage({ type: 'heartbeat', payload: { trigger: 'unread-digest', content: `${frame}\n\n${digestSummary}` } }, POD),
      'p1',
      NATIVE_TOOL_NAMES,
    );
    expect(out.startsWith(frame)).toBe(true);
    expect(out).toContain(digestSummary);
    expect(out).toContain(HEARTBEAT_POST_LINE);
  });
});

// The real digest summary (digestFrame) ends by telling the seat to pull the
// threads with commonly_get_messages. A native turn has no such tool, and the
// line rides in the message body, after the kernel frames, where the native
// frame rewrite never looks. So every hosted turn with unread activity was
// told to call a tool it was never given.
describe('a native turn\'s digest names only tools a native turn has', () => {
  const { digestConversationFrame, DIGEST_PULL_LINE } = require('../../../services/digestFrame');
  const { nativeCueFromKernel, NATIVE_DIGEST_PULL_LINE } = require('../../../services/nativeKernelCue');
  const { NATIVE_TOOL_NAMES } = require('../../../services/nativeRuntimeService');
  const { buildHeartbeatContent } = require('../../../services/heartbeatCue');

  const podId = '6aeb8bc75a12e3e23872e765';
  const digest = digestConversationFrame([
    { payload: { messageId: 1, threadRootId: 129000 } },
    { payload: { messageId: 2, threadRootId: 129000 } },
    { payload: { messageId: 3 } },
  ]);
  const toolsNamed = (text) => [...new Set(text.match(/commonly_[a-z_]+/g) || [])];
  const native = (type, content) => nativeCueFromKernel(
    buildUserMessage({ type, payload: { content } }, POD),
    podId,
    NATIVE_TOOL_NAMES,
  );

  it('the kernel digest names a tool native lacks (the positive control)', () => {
    expect(toolsNamed(digest).filter((name) => !NATIVE_TOOL_NAMES.includes(name))).toEqual(['commonly_get_messages']);
  });

  it.each([
    ['a scheduled heartbeat', 'heartbeat', `${buildHeartbeatContent(podId)}\n\n${digest}`],
    ['a framed @mention', 'chat.mention', `[Pod context: this conversation is in pod \`${podId}\`.]\n\n@scout hi\n\n${digest}`],
    ['an unframed wake', 'message.posted', `hello\n\n${digest}`],
  ])('%s keeps the counts and points at commonly_read_context', (_label, type, content) => {
    const out = native(type, content);
    expect(toolsNamed(out).filter((name) => !NATIVE_TOOL_NAMES.includes(name))).toEqual([]);
    expect(out).toContain('- thread 129000: 2 unread');
    expect(out).toContain('- pod conversation: 1 unread');
    expect(out).toContain('context only, no reply needed');
    expect(out).toContain(NATIVE_DIGEST_PULL_LINE);
    expect(out).not.toContain(DIGEST_PULL_LINE);
  });

  // CodeRabbit on #3460: an install that declares its tools may leave out
  // commonly_read_context, and then the rewritten line names a tool that
  // agent is not given either. The counts stay; only the pointer goes.
  it('drops the pointer, and keeps the counts, when the agent is not given commonly_read_context', () => {
    const out = nativeCueFromKernel(
      buildUserMessage({ type: 'message.posted', payload: { content: `hello\n\n${digest}` } }, POD),
      podId,
      NATIVE_TOOL_NAMES,
      { readContextOffered: false },
    );
    expect(toolsNamed(out)).toEqual([]);
    expect(out).toContain('- thread 129000: 2 unread');
    expect(out).toContain('context only, no reply needed');
    expect(out.endsWith('- pod conversation: 1 unread')).toBe(true);
  });

  it('leaves a person\'s own words alone when they name the tool', () => {
    const said = 'why did commonly_get_messages fail for you?';
    const out = native('chat.mention', `${said}\n\n${digest}`);
    expect(out).toContain(said);
    expect(out.match(/commonly_get_messages/g)).toHaveLength(1);
  });
});

// F190: which turns may post their final text. Decided by the trigger alone,
// never by the text: every addressed or asked-to-post turn keeps the fallback.
describe('finalTextReachesPod', () => {
  const { finalTextReachesPod } = require('../../../services/nativeRuntimeService');

  it('a heartbeat\'s final text does not reach the pod', () => {
    expect(finalTextReachesPod({ type: 'heartbeat', payload: {} })).toBe(false);
  });

  it.each(['chat.mention', 'thread.mention', 'dm.message', 'mention', 'chat.message', 'message.posted', 'first_contact', 'task.assigned', 'pod.join'])(
    'a %s turn keeps posting its final text',
    (type) => {
      expect(finalTextReachesPod({ type, payload: {} })).toBe(true);
    },
  );
});
