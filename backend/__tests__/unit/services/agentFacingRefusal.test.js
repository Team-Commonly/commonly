const {
  HOSTED_OWNER_REFUSAL_CODES, AGENT_CONNECTION_UNAVAILABLE, agentFacingRefusal, agentFacingRefusalCode, isAgentCaller,
} = require('../../../services/agentFacingRefusal');
const { errorPayload } = require('../../../routes/mcpGrants');

// F271: an agent is told a connection is unavailable, never what happened to
// the person who connected it. Every owner code maps to the one generic answer.
describe('agentFacingRefusal', () => {
  test.each(Object.values(HOSTED_OWNER_REFUSAL_CODES))('%s reaches an agent as the generic refusal', (code) => {
    const seen = agentFacingRefusal({ code, message: 'the person who connected this connection is suspended' });
    expect(seen).toMatchObject(AGENT_CONNECTION_UNAVAILABLE);
    expect(agentFacingRefusalCode(code)).toBe('connection_unavailable');
    const payload = errorPayload(Object.assign(new Error('the person who connected this connection is suspended'), { code }));
    expect(payload).toEqual({ error: 'connection_unavailable', message: AGENT_CONNECTION_UNAVAILABLE.message });
    expect(JSON.stringify(payload)).not.toMatch(/suspended|deleting|no longer|bot account/);
  });

  test('a thrown refusal keeps its message and details', () => {
    const thrown = Object.assign(new Error('this grant was revoked'), { code: 'grant_revoked', details: { grantId: 'g1' } });
    expect(errorPayload(thrown)).toEqual({ error: 'grant_revoked', message: 'this grant was revoked', details: { grantId: 'g1' } });
  });

  test('isAgentCaller: a runtime token or a bot account, never a person', () => {
    expect(isAgentCaller({ agentUser: { _id: 'a1' } })).toBe(true);
    expect(isAgentCaller({ botCaller: { username: 'b' } })).toBe(true);
    expect(isAgentCaller({ user: { id: 'u1' }, userId: 'u1' })).toBe(false);
  });

  test('any other refusal passes through unchanged', () => {
    expect(agentFacingRefusal({ code: 'grant_revoked', message: 'revoked' })).toEqual({ code: 'grant_revoked', message: 'revoked' });
    expect(agentFacingRefusalCode('not_in_audience')).toBe('not_in_audience');
    expect(agentFacingRefusalCode(undefined)).toBeNull();
  });
});
