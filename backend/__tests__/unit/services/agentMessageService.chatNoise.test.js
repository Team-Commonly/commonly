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
