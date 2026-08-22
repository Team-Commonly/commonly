/**
 * Phase 2 — hirePersona, the Scout install block generalized (ADR-022 D1/D2).
 *
 * Seams: the service function's observable effects — the installation row,
 * the bot's pod membership, the intro post — and its refusals. Contract:
 *
 *  - per-user identity: instanceId is `u` + sha256(userId)[0:10] — D1's one
 *    colleague per user per persona, same convention as Scout's
 *  - the registry row's verified flag IS the hireable switch — the same
 *    curation boundary the catalog gate enforces (#1072); unverified → refuse
 *  - perUser manifests (Scout) are not hireable here — signup owns them
 *  - idempotent: re-hiring upserts the same (agentName, podId, instanceId),
 *    never a duplicate row (the #1086 bug class, guarded by construction)
 *  - it speaks first: the manifest's introMessage posts on placement
 */

jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { findOneAndUpdate: jest.fn() },
  AgentRegistry: { findOne: jest.fn() },
}));

jest.mock('../../../models/Pod', () => ({
  updateOne: jest.fn(),
}));

jest.mock('../../../services/agentIdentityService', () => ({
  getOrCreateAgentUser: jest.fn(),
}));

jest.mock('../../../services/agentMessageService', () => ({
  postMessage: jest.fn().mockResolvedValue({ success: true }),
}));

jest.mock('../../../scripts/seed-native-agents', () => ({
  buildInstallationConfig: jest.fn(() => ({ runtime: { runtimeType: 'native' } })),
}));

const { createHash } = require('crypto');
const { AgentInstallation, AgentRegistry } = require('../../../models/AgentRegistry');
const Pod = require('../../../models/Pod');
const AgentIdentityService = require('../../../services/agentIdentityService');
const AgentMessageService = require('../../../services/agentMessageService');
const { hirePersona } = require('../../../services/personaHireService');

const expectedInstanceId = (userId) => `u${createHash('sha256').update(String(userId)).digest('hex').slice(0, 10)}`;

describe('personaHireService.hirePersona', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AgentRegistry.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ agentName: 'recorder', verified: true }),
    });
    AgentInstallation.findOneAndUpdate.mockResolvedValue({ _id: 'install-1' });
    AgentIdentityService.getOrCreateAgentUser.mockResolvedValue({ _id: 'bot-1' });
    Pod.updateOne.mockResolvedValue({});
  });

  it('hires with the per-user identity and posts the intro', async () => {
    const result = await hirePersona({ agentName: 'recorder', userId: 'user-42', podId: 'pod-9' });

    const iid = expectedInstanceId('user-42');
    expect(result).toMatchObject({ agentName: 'recorder', instanceId: iid, podId: 'pod-9' });

    // Idempotent upsert on the full identity key — the #1086 dup class
    // cannot happen by construction.
    expect(AgentInstallation.findOneAndUpdate).toHaveBeenCalledWith(
      { agentName: 'recorder', podId: 'pod-9', instanceId: iid },
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({ installedBy: 'user-42' }),
      }),
      expect.objectContaining({ upsert: true }),
    );

    // Membership + it-speaks-first.
    expect(Pod.updateOne).toHaveBeenCalled();
    expect(AgentMessageService.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'recorder',
        instanceId: iid,
        podId: 'pod-9',
        content: expect.stringContaining('Recorder'),
      }),
    );
  });

  it('refuses an unverified persona — verified IS the hireable switch', async () => {
    AgentRegistry.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ agentName: 'recorder', verified: false }),
    });
    await expect(hirePersona({ agentName: 'recorder', userId: 'u', podId: 'p' }))
      .rejects.toMatchObject({ code: 'persona_not_available' });
    expect(AgentInstallation.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('refuses an unknown persona', async () => {
    await expect(hirePersona({ agentName: 'nonexistent', userId: 'u', podId: 'p' }))
      .rejects.toMatchObject({ code: 'persona_not_found' });
  });

  it('refuses perUser manifests — signup owns Scout, not the hire path', async () => {
    AgentRegistry.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ agentName: 'scout', verified: true }),
    });
    await expect(hirePersona({ agentName: 'scout', userId: 'u', podId: 'p' }))
      .rejects.toMatchObject({ code: 'persona_not_available' });
  });

  it('a failed intro post does not fail the hire — the seat exists either way', async () => {
    AgentMessageService.postMessage.mockRejectedValue(new Error('pg down'));
    const result = await hirePersona({ agentName: 'recorder', userId: 'user-42', podId: 'pod-9' });
    expect(result.agentName).toBe('recorder');
  });
});
