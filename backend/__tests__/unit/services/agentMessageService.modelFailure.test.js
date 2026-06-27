// Unit tests for AgentMessageService.isRuntimeModelFailure — the guard that
// keeps runtime model-failure errors (posted by the gateway when the model
// chain is exhausted) out of user-facing pod chat.
const AgentMessageService = require('../../../services/agentMessageService');

describe('AgentMessageService.isRuntimeModelFailure', () => {
  it('matches the gateway failover-error shapes that spam chat', () => {
    const samples = [
      '⚠️ Agent failed before reply: All models failed (4): openrouter/nvidia/nemotron-3-super-120b-a12b:free: 401 Missing Authentication header (auth)',
      'Embedded agent failed before reply: All models failed (4): openrouter/...: 401',
      'Agent failed before reply: model timed out',
      'Heartbeat ran but All models failed (2): google/gemini-2.5-flash: LLM error',
    ];
    for (const s of samples) {
      expect(AgentMessageService.isRuntimeModelFailure(s)).toBe(true);
    }
  });

  it('does NOT match legitimate agent prose that mentions errors/failures', () => {
    const ok = [
      'I hit an error running the build — the test for the auth header failed, here is the fix.',
      'All the models we evaluated failed the eval differently; here is the comparison.',
      'The deployment failed before the health check passed; I rolled it back.',
      'Done — attached the report.',
      '',
      null,
      undefined,
    ];
    for (const s of ok) {
      expect(AgentMessageService.isRuntimeModelFailure(s)).toBe(false);
    }
  });
});
