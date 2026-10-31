/**
 * The operator-key mint binding (TASK-330, Vera's read §2): a key is one
 * agent's, so a grant on its row may name that agent alone. Pure function, so
 * these arms need no database.
 */
const { operatorKeyAudienceRefusal } = require('../../../services/hostedMcpOperatorKey');

const KEY_ENTRY = { credentialMode: 'operator_key' };
const OAUTH_ENTRY = { credentialMode: undefined };
const bound = (agentId) => ({ config: { agentId } });

describe('operatorKeyAudienceRefusal', () => {
  it('leaves OAuth rows alone, so the member default still applies to them', () => {
    expect(operatorKeyAudienceRefusal(OAUTH_ENTRY, bound('a1'), undefined)).toBeNull();
    expect(operatorKeyAudienceRefusal(undefined, bound('a1'), undefined)).toBeNull();
  });

  it('names exactly the bound agent', () => {
    expect(operatorKeyAudienceRefusal(KEY_ENTRY, bound('a1'), ['a1'])).toBeNull();
  });

  it('refuses an omitted audience, which would otherwise default to every member', () => {
    expect(operatorKeyAudienceRefusal(KEY_ENTRY, bound('a1'), undefined)).toMatch(/omitted audience/);
  });

  it('refuses another agent, and refuses the bound agent alongside another', () => {
    expect(operatorKeyAudienceRefusal(KEY_ENTRY, bound('a1'), ['a2'])).toBe('audience must be exactly [a1]');
    expect(operatorKeyAudienceRefusal(KEY_ENTRY, bound('a1'), ['a1', 'a2'])).toBe('audience must be exactly [a1]');
  });

  it('refuses an empty audience, which names nobody', () => {
    expect(operatorKeyAudienceRefusal(KEY_ENTRY, bound('a1'), [])).toBe('audience must be exactly [a1]');
  });

  it('refuses a row with no bound agent, since the key has no owner to name', () => {
    expect(operatorKeyAudienceRefusal(KEY_ENTRY, { config: {} }, ['a1'])).toBe('this key is not bound to an agent');
  });
});
