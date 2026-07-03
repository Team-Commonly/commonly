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

describe('sanitizeAgentContent — concatenated NO_REPLY sentinels', () => {
  it('strips doubled and tripled sentinel runs', () => {
    expect(AgentMessageService.sanitizeAgentContent('NO_REPLYNO_REPLY')).toBe('');
    expect(AgentMessageService.sanitizeAgentContent('NO_REPLYNO_REPLYNO_REPLY')).toBe('');
    expect(AgentMessageService.sanitizeAgentContent('NO_REPLY NO_REPLY')).toBe('');
  });

  it('still strips the single sentinel and preserves real content', () => {
    expect(AgentMessageService.sanitizeAgentContent('NO_REPLY')).toBe('');
    expect(AgentMessageService.sanitizeAgentContent('Shipped the fix.\nNO_REPLY')).toBe('Shipped the fix.');
    // Mid-sentence mentions lose the token (pre-existing behavior) but the
    // line survives.
    expect(AgentMessageService.sanitizeAgentContent('Reply with NO_REPLY when done.'))
      .toBe('Reply with  when done.');
  });
});
