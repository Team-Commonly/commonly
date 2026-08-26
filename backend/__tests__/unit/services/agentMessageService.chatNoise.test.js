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

  it('suppresses substantive replies that begin with a bare sentinel', () => {
    // Sam ratified TASK-067 (2026-08-26): the first non-whitespace bare
    // NO_REPLY token suppresses the entire reply, including its body.
    expect(AgentMessageService.sanitizeAgentContent('NO_REPLY\nHere is the real answer.'))
      .toBe('');
    expect(AgentMessageService.sanitizeAgentContent('\n\t NO_REPLY.\nHere is the real answer.'))
      .toBe('');
  });

  it('keeps leading code-formatted sentinel mentions intact', () => {
    expect(AgentMessageService.sanitizeAgentContent('`NO_REPLY`\nHere is the real answer.'))
      .toBe('`NO_REPLY`\nHere is the real answer.');
    expect(AgentMessageService.sanitizeAgentContent(
      '```text\nNO_REPLY\n```\nHere is the real answer.',
    )).toBe('```text\nNO_REPLY\n```\nHere is the real answer.');
  });

  it('keeps mid-reply and trailing bare sentinels as strip-and-post', () => {
    expect(AgentMessageService.sanitizeAgentContent('Reply with NO_REPLY when done.'))
      .toBe('Reply with  when done.');
    expect(AgentMessageService.sanitizeAgentContent('Shipped the fix.\nNO_REPLY'))
      .toBe('Shipped the fix.');
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

  const leadingSuppressionWarnings = () => warn.mock.calls
    .map(([first]) => String(first))
    .filter((line) => line.includes('suppressed substantive reply with leading bare sentinel'));

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

  it('does not count a leading-bare suppression as a strip edit', () => {
    // Sam ratified TASK-067 (2026-08-26). Leading-bare NO_REPLY is now a
    // suppression with its own warning, not the strip-and-post edit #1252
    // measures. Keeping the metrics separate prevents false strip rates.
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

  // Delivery pin, not a behaviour pin — and the distinction is the point.
  // Mutating the postMessage call site to drop `{ agentName, instanceId, podId }`
  // left every assertion above green: they exercise the sanitizer directly, so
  // they pin the predicate and say nothing about whether the posting path ever
  // opts in. A warn that is never reached is indistinguishable from a warn that
  // never fires. The behavioural version needs postMessage's ~60-line mock
  // harness (see agentMessageService.phantom-directive.test.js); this is the
  // cheap pin that catches the mutation that actually happened.
  it('is wired at the postMessage call site — the opt-in is what makes it fire', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '../../../services/agentMessageService.ts'),
      'utf8',
    );
    // Comments are stripped before matching. A bare `toContain` on the call
    // text is satisfied by PROSE: delete the argument from the real call and
    // leave the old form in a `//` comment above it, and the assertion passes
    // with the feature entirely off. Not hypothetical in this file — it
    // discusses `sanitizeAgentContent` in comments at :110 and :1126.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    // Anchored on the assignment, so the match is the statement that feeds
    // postMessage rather than any mention of the call anywhere in the file.
    expect(code).toMatch(
      /let sanitizedContent = AgentMessageService\.sanitizeAgentContent\(\s*content,\s*\{[^}]*agentName[^}]*instanceId[^}]*podId[^}]*\}\s*\)/,
    );
  });

  it('names the agent, instance and pod, like the two suppressions beside it', () => {
    AgentMessageService.sanitizeAgentContent('A reply of NO_REPLY means silence.', OBSERVE);
    const [line] = stripWarnings();
    expect(line).toContain('agent=openclaw');
    expect(line).toContain('instance=nova');
    expect(line).toContain('pod=pod123');
  });

  it('logs the identity and original excerpt when suppressing a leading bare sentinel', () => {
    const input = 'NO_REPLY\nHere is the real answer.';
    expect(AgentMessageService.sanitizeAgentContent(input, OBSERVE)).toBe('');
    expect(leadingSuppressionWarnings()).toHaveLength(1);
    const [line] = leadingSuppressionWarnings();
    expect(line).toContain('agent=openclaw');
    expect(line).toContain('instance=nova');
    expect(line).toContain('pod=pod123');
    expect(line).toContain(input);
  });
});

describe('AgentMessageService.postMessage — silent agent-DM conclusion hook', () => {
  let warn;

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    jest.restoreAllMocks();
  });

  it('starts the conclusion-memory flow for a leading bare sentinel', async () => {
    // TASK-067's ratified suppression is a silence, so ADR-012 §4 records
    // the existing prior-turn takeaway for both peers in an agent-DM. The
    // suppressed body itself is intentionally never persisted.
    const conclusion = jest.spyOn(AgentMessageService, 'maybeRecordAgentDmConclusion')
      .mockResolvedValue(undefined);

    const result = await AgentMessageService.postMessage({
      agentName: 'nova',
      instanceId: 'default',
      podId: '507f1f77bcf86cd799439011',
      content: 'NO_REPLY\nThis body is intentionally suppressed.',
    });

    expect(result).toEqual({ success: true, skipped: true, reason: 'silent_or_empty' });
    expect(conclusion).toHaveBeenCalledWith({
      podId: '507f1f77bcf86cd799439011',
      senderAgentName: 'nova',
      senderInstanceId: 'default',
    });
  });
});
