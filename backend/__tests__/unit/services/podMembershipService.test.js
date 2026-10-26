jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
const Pod = require('../../../models/Pod');
const { requirePodMember } = require('../../../services/podMembershipService');
test.each([
  { userId: 'viewer', role: 'viewer' },
  { userId: { toString: () => 'viewer' }, role: 'viewer' },
])('viewer-role membership cannot write', async (membership) => {
  Pod.findById.mockReturnValue({ lean: jest.fn().mockResolvedValue({ members: [membership] }) });
  await expect(requirePodMember('pod', 'viewer', { write: true })).resolves.toMatchObject({ status: 403 });
});
test('legacy ID membership keeps write access', async () => {
  Pod.findById.mockReturnValue({ lean: jest.fn().mockResolvedValue({ members: ['member'] }) });
  await expect(requirePodMember('pod', 'member', { write: true })).resolves.toMatchObject({ canWrite: true });
});
