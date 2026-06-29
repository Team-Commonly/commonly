// Taxonomy unit test for the hosted-agent entitlement gate's single source of
// truth: agentIdentityService.isCloudRuntime + CLOUD_RUNTIME_TYPES.
const AgentIdentityService = require('../../../services/agentIdentityService');

const { isCloudRuntime, CLOUD_RUNTIME_TYPES } = AgentIdentityService;

describe('agentIdentityService cloud-runtime taxonomy', () => {
  it('exposes the helper + set off the service module', () => {
    expect(typeof isCloudRuntime).toBe('function');
    expect(CLOUD_RUNTIME_TYPES).toBeInstanceOf(Set);
  });

  it('CLOUD_RUNTIME_TYPES is exactly the hosted runtime set', () => {
    expect([...CLOUD_RUNTIME_TYPES].sort()).toEqual(
      ['internal', 'managed-agents', 'moltbot', 'native'],
    );
  });

  describe('cloud runtimes (gated)', () => {
    it.each([
      ['moltbot'],
      ['internal'],
      ['native'],
      ['managed-agents'],
    ])('%s is cloud', (runtimeType) => {
      expect(isCloudRuntime({ runtimeType })).toBe(true);
    });

    it('codex with no host is cloud (LiteLLM-proxied default)', () => {
      expect(isCloudRuntime({ runtimeType: 'codex' })).toBe(true);
      expect(isCloudRuntime({ runtimeType: 'codex', host: 'cloud' })).toBe(true);
    });

    it('is case-insensitive on runtimeType', () => {
      expect(isCloudRuntime({ runtimeType: 'MOLTBOT' })).toBe(true);
    });
  });

  describe('BYO runtimes (open)', () => {
    it.each([
      ['webhook'],
      ['claude-code'],
    ])('%s is BYO', (runtimeType) => {
      expect(isCloudRuntime({ runtimeType })).toBe(false);
    });

    it("host:'byo' always wins, even for an otherwise-cloud runtimeType", () => {
      expect(isCloudRuntime({ runtimeType: 'moltbot', host: 'byo' })).toBe(false);
      expect(isCloudRuntime({ runtimeType: 'codex', host: 'byo' })).toBe(false);
      expect(isCloudRuntime({ runtimeType: 'native', host: 'byo' })).toBe(false);
    });

    it('unknown / unspecified runtimeType defaults to NON-cloud (open)', () => {
      expect(isCloudRuntime({ runtimeType: '' })).toBe(false);
      expect(isCloudRuntime({ runtimeType: 'something-new' })).toBe(false);
      expect(isCloudRuntime({})).toBe(false);
      expect(isCloudRuntime(null)).toBe(false);
      expect(isCloudRuntime(undefined)).toBe(false);
    });
  });
});
