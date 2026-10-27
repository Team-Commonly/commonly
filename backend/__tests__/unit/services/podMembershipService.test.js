jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
const Pod = require('../../../models/Pod');
const { requirePodMember } = require('../../../services/podMembershipService');

const POD_ID = '6a692a1be833c668acdb84cf';
test.each([
  { userId: 'viewer', role: 'viewer' },
  { userId: { toString: () => 'viewer' }, role: 'viewer' },
])('viewer-role membership cannot write', async (membership) => {
  Pod.findById.mockReturnValue({ lean: jest.fn().mockResolvedValue({ members: [membership] }) });
  await expect(requirePodMember(POD_ID, 'viewer', { write: true })).resolves.toMatchObject({ status: 403 });
});
test('legacy ID membership keeps write access', async () => {
  Pod.findById.mockReturnValue({ lean: jest.fn().mockResolvedValue({ members: ['member'] }) });
  await expect(requirePodMember(POD_ID, 'member', { write: true })).resolves.toMatchObject({ canWrite: true });
});
test.each(['undefined', '', undefined, 'pod'])('a podId that is not a pod id is a 400, and no lookup runs (%p)', async (podId) => {
  Pod.findById.mockClear();
  await expect(requirePodMember(podId, 'member')).resolves.toEqual({ error: 'podId must be a pod id', status: 400 });
  expect(Pod.findById).not.toHaveBeenCalled();
});
