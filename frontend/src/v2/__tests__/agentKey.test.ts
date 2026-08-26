import { agentKeyFor } from '../utils/agentKey';

describe('agentKeyFor — the member-identity key', () => {
  test('two agents sharing instanceId "default" get DISTINCT keys', () => {
    // The regression this file exists for: nine BYO fleet seats all carry
    // instanceId 'default'; the pre-2026-08-26 key (`instanceId || agentName`)
    // collapsed them onto one entry, so clicking ANY agent's byline or member
    // row rendered the same seat's profile.
    const a = agentKeyFor({ agentName: 'fable-lead', instanceId: 'default' });
    const b = agentKeyFor({ agentName: 'ux-lead', instanceId: 'default' });
    expect(a).not.toBe(b);
    expect(a).toBe('fable-lead:default');
    expect(b).toBe('ux-lead:default');
  });

  test('missing instanceId normalizes to default, matching backend identity keys', () => {
    expect(agentKeyFor({ agentName: 'sage' })).toBe('sage:default');
  });

  test('registry rows that carry name instead of agentName still key correctly', () => {
    expect(agentKeyFor({ name: 'sage', instanceId: 'sage-seo-lead' })).toBe('sage:sage-seo-lead');
  });
});
