const {
  HOSTED_OWNER_REFUSAL_CODES, AGENT_CONNECTION_UNAVAILABLE, agentFacingRefusal, agentFacingRefusalCode,
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

  test('any other refusal passes through unchanged', () => {
    expect(agentFacingRefusal({ code: 'grant_revoked', message: 'revoked' })).toEqual({ code: 'grant_revoked', message: 'revoked' });
    expect(agentFacingRefusalCode('not_in_audience')).toBe('not_in_audience');
    expect(agentFacingRefusalCode(undefined)).toBeNull();
  });
});
