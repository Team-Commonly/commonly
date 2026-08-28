// Guards against the two live-pod chat-noise leaks found 2026-07-03:
//  - gateway tool-status failure notes ("⚠️ 📝 Edit: ... failed") posting
//    to pods once per failed workspace-file edit
//  - concatenated NO_REPLY sentinels ("NO_REPLYNO_REPLY") sailing through
//    the word-boundary strip and posting verbatim
const AgentMessageService = require('../../../services/agentMessageService');

describe('AgentMessageService.isRuntimeToolFailureNote', () => {
  it('matches the gateway tool-failure notes seen in live pods', () => {
    const samples = [
      '⚠️ 📝 Edit: in /workspace/nova/MEMORY.md (196 chars) failed',
      '⚠️ 📝 Edit: in /workspace/theo/MEMORY.md (1588 chars) failed',
      '⚠️ ✉️ Message failed',
      '⚠️ 🔧 Exec: npm test failed',
    ];
    for (const s of samples) {
      expect(AgentMessageService.isRuntimeToolFailureNote(s)).toBe(true);
    }
  });

  it('does NOT match agent prose about failures or multi-line content', () => {
    const ok = [
      'The MEMORY.md edit failed twice, so I rewrote the file instead — done.',
      '⚠️ Heads up: the deploy failed, investigating now and will report back.', // no emoji tool tag
      '⚠️ 📝 Edit: in /workspace/nova/MEMORY.md failed\nRetrying with a fresh read.', // multi-line = composed reply
      'failed',
      '',
      null,
      undefined,
    ];
    for (const s of ok) {
      expect(AgentMessageService.isRuntimeToolFailureNote(s)).toBe(false);
    }
  });
});

describe('sanitizeAgentContent — NO_REPLY suppression and sanitization', () => {
  it('strips only sentinel-only replies, including legacy duplicated runs', () => {
    expect(AgentMessageService.sanitizeAgentContent('NO_REPLY')).toBe('');
    expect(AgentMessageService.sanitizeAgentContent('NO_REPLYNO_REPLY')).toBe('');
    expect(AgentMessageService.sanitizeAgentContent('NO_REPLYNO_REPLYNO_REPLY')).toBe('');
    expect(AgentMessageService.sanitizeAgentContent('NO_REPLY NO_REPLY')).toBe('');
  });

  it('keeps fenced sentinel-only replies silent before preserving code spans', () => {
    expect(AgentMessageService.sanitizeAgentContent('```text\nNO_REPLY\n```')).toBe('');
  });

  it('keeps substantive replies but strips bare producer-leakage tokens', () => {
    expect(AgentMessageService.sanitizeAgentContent('Shipped the fix.\nNO_REPLY'))
      .toBe('Shipped the fix.');
    expect(AgentMessageService.sanitizeAgentContent('Reply with NO_REPLY when done.'))
      .toBe('Reply with  when done.');
  });

  it('preserves code-formatted sentinel mentions', () => {
    expect(AgentMessageService.sanitizeAgentContent('Reply with `NO_REPLY` when done.'))
      .toBe('Reply with `NO_REPLY` when done.');
    expect(AgentMessageService.sanitizeAgentContent(
      'The literal is ``NO_REPLY``; bare NO_REPLY is leakage.',
    )).toBe('The literal is ``NO_REPLY``; bare  is leakage.');
    expect(AgentMessageService.sanitizeAgentContent(
      'Example:\n```text\nNO_REPLY\n```\nDo not copy bare NO_REPLY.',
    )).toBe('Example:\n```text\nNO_REPLY\n```\nDo not copy bare .');
    expect(AgentMessageService.sanitizeAgentContent(
      '```text\nNO_REPLY is discussed here.\n```',
    )).toBe('NO_REPLY is discussed here.');
  });

  // TASK-067 (Sam, ratified 2026-08-26). Position is the whole discriminator:
  // a sentinel that OPENS the reply is intended silence and suppresses it; the
  // same token anywhere else keeps #785's strip-and-post, because there it is
  // producer leakage inside a reply the agent meant to send.
  it('suppresses a reply that OPENS with a bare sentinel — the AX-43 leak shape', () => {
    // The exact measured shape: the orphan '.' is the period after NO_REPLY,
    // which is what survived the strip in all 11 leaked messages.
    expect(AgentMessageService.sanitizeAgentContent(
      'NO_REPLY.\n\nNo decision pending, so no post.',
    )).toBe('');
    expect(AgentMessageService.sanitizeAgentContent(
      'NO_REPLY\nHere is the real answer.',
    )).toBe('');
    expect(AgentMessageService.sanitizeAgentContent(
      'NO_REPLY — standing down, the claim is held by a peer.',
    )).toBe('');
  });

  it('consumes a leading sentinel RUN, like the total-match path', () => {
    // Gateways join silent blocks without a separator; a run at the head is
    // the same intent as one token.
    expect(AgentMessageService.sanitizeAgentContent('NO_REPLYNO_REPLY\nreasoning')).toBe('');
    expect(AgentMessageService.sanitizeAgentContent('NO_REPLY NO_REPLY\nreasoning')).toBe('');
  });

  it('leaves mid and trailing sentinels on strip-and-post', () => {
    // The half of the contract TASK-067 did NOT change. If these ever start
    // returning '', a leaked token silences a genuine reply — the error #785
    // exists to prevent.
    expect(AgentMessageService.sanitizeAgentContent('Shipped the fix.\nNO_REPLY'))
      .toBe('Shipped the fix.');
    expect(AgentMessageService.sanitizeAgentContent('A reply of NO_REPLY means silence.'))
      .toBe('A reply of  means silence.');
  });

  it('does not suppress when the leading sentinel is a deliberate mention', () => {
    // Backticked and fenced sentinels are mentions, not silence — the
    // suppression check sits below the fence return and never sees them.
    expect(AgentMessageService.sanitizeAgentContent('`NO_REPLY` is the sentinel.'))
      .toBe('`NO_REPLY` is the sentinel.');
    expect(AgentMessageService.sanitizeAgentContent(
      '```text\nNO_REPLY\nis discussed here.\n```',
    )).toBe('NO_REPLY\nis discussed here.');
  });

  it('respects the word boundary at the head', () => {
    // Controls: the token must be bare. A word character on either side means
    // it is ordinary prose, and suppressing there would swallow real replies.
    expect(AgentMessageService.sanitizeAgentContent('NO_REPLYING is not the sentinel.'))
      .toBe('NO_REPLYING is not the sentinel.');
    expect(AgentMessageService.sanitizeAgentContent('NO_REPLY_MODE is a config key.'))
      .toBe('NO_REPLY_MODE is a config key.');
  });

  it('drops known bare runtime artifacts without swallowing terse replies', () => {
    expect(AgentMessageService.sanitizeAgentContent('RGCTX')).toBe('');

    // Short acknowledgements and formatted literals are intentional agent
    // output; only observed wrapper artifacts are silent.
    for (const content of [
      'Yes', 'Done', 'LGTM', 'HTTP', 'HTTPS', 'XHTML', 'SHTML', 'MSSQL',
      'KHTML', 'GRPCS', '`RGCTX`',
    ]) {
      expect(AgentMessageService.sanitizeAgentContent(content)).toBe(content);
    }
  });
});

// The strip that rewrites an agent's substantive reply is the only one of the
// three suppressions in this path that left no trace anywhere — not in the
// stored message (the token is gone), not in the transcript, not in the logs.
// Every occurrence ever noticed was caught by a reader who happened to know
// the original text, which is why the rate has never been measurable. These
// pin the warn's PREDICATE, not its wording: it must fire on an edit and stay
// silent on a suppression, or the count it produces means nothing.
describe('AgentMessageService.sanitizeAgentContent — strip observability', () => {
  let warn;

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  const stripWarnings = () => warn.mock.calls
    .map(([first]) => String(first))
    .filter((line) => line.includes('stripped bare sentinel'));

  const OBSERVE = { agentName: 'openclaw', instanceId: 'nova', podId: 'pod123' };

  it('warns when a bare sentinel is edited out of a substantive reply', () => {
    const out = AgentMessageService.sanitizeAgentContent(
      'A reply of NO_REPLY means silence.',
      OBSERVE,
    );
    // The defect itself: the sentence is rewritten and still posts.
    expect(out).toBe('A reply of  means silence.');
    expect(stripWarnings()).toHaveLength(1);
  });

  it('does NOT count a LEADING bare sentinel as an edit — it is a suppression now', () => {
    // TASK-067 moved this shape from strip-and-post to suppress. It must not
    // inflate the edit metric, for the same reason total-match does not: the
    // count is of replies we REWROTE, and this one we withheld.
    const out = AgentMessageService.sanitizeAgentContent(
      'NO_REPLY\nHere is the real answer.',
      OBSERVE,
    );
    expect(out).toBe('');
    expect(stripWarnings()).toHaveLength(0);
  });

  it('stays silent when the sentinel IS the whole reply — suppression, not an edit', () => {
    // Total-match returns before the strip loop, so a working-as-designed
    // silence must not inflate the count. If this ever warns, the metric
    // measures normal traffic and the rate is worthless.
    expect(AgentMessageService.sanitizeAgentContent('NO_REPLY', OBSERVE)).toBe('');
    expect(AgentMessageService.sanitizeAgentContent('  NO_REPLY  ', OBSERVE)).toBe('');
    expect(AgentMessageService.sanitizeAgentContent('NO_REPLYNO_REPLY', OBSERVE)).toBe('');
    expect(stripWarnings()).toHaveLength(0);
  });

  it('stays silent on a backticked sentinel and on ordinary prose', () => {
    // Controls. A backticked mention is deliberate and is copied verbatim, so
    // `cleaned === trimmed` and nothing fires. Ordinary prose exercises the
    // same loop over every character without ever matching.
    AgentMessageService.sanitizeAgentContent('Backtick it: `NO_REPLY` survives.', OBSERVE);
    AgentMessageService.sanitizeAgentContent('An ordinary reply with no sentinel at all.', OBSERVE);
    expect(stripWarnings()).toHaveLength(0);
  });

  it('stays silent without `observe` — the read-time predicate must not count', () => {
    // `systemExchangeTriggers.findPreviousNonSilentMessage` re-sanitizes up to
    // 20 already-stored messages to find the last substantive one. Any of them
    // stored before the strip shipped still contains a bare sentinel, so an
    // unconditional warn would fire on every scan and the metric would count
    // reads of history instead of fresh edits.
    const out = AgentMessageService.sanitizeAgentContent('A reply of NO_REPLY means silence.');
    expect(out).toBe('A reply of  means silence.');
    expect(stripWarnings()).toHaveLength(0);
  });

  // The delivery pin that used to live here — a regex over the service's
  // source text, asserting the `postMessage` call site passes
  // `{ agentName, instanceId, podId }` — is GONE, replaced rather than
  // hardened a third time. It was defeated by a `//` comment decoy, then by
  // `/* */`, and each fix bought one counterexample while leaving the class
  // open: any assertion over source text passes on any occurrence that does
  // not execute. Its replacement drives `postMessage` and asserts the warn
  // actually fires — see agentMessageService.observabilityDelivery.test.js,
  // which also covers the two sibling suppressions that never had a delivery
  // pin of any kind.

  it('names the agent, instance and pod, like the two suppressions beside it', () => {
    AgentMessageService.sanitizeAgentContent('A reply of NO_REPLY means silence.', OBSERVE);
    const [line] = stripWarnings();
    expect(line).toContain('agent=openclaw');
    expect(line).toContain('instance=nova');
    expect(line).toContain('pod=pod123');
  });
});
