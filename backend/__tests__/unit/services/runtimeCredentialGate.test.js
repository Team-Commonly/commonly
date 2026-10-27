/**
 * runtimeCredentialGate is the one copy of the credential-ledger rules that
 * both the HTTP middleware (agentRuntimeAuth) and the agent WebSocket apply.
 */
const mockIsAccountDeleting = jest.fn();
jest.mock('../../../services/accountDeletionState', () => ({
  isAccountDeleting: (...args) => mockIsAccountDeleting(...args),
}));
const mockMachineHasLiveAuthorization = jest.fn();
jest.mock('../../../services/machineService', () => ({
  machineHasLiveAuthorization: (...args) => mockMachineHasLiveAuthorization(...args),
}));
const mockParent = jest.fn();
jest.mock('../../../models/AgentCredential', () => ({
  findById: jest.fn(() => ({ select: () => ({ lean: () => Promise.resolve(mockParent()) }) })),
}));

const {
  runtimeCredentialRefusalReason,
  embeddedRuntimeTokenExpired,
} = require('../../../services/runtimeCredentialGate');

const live = (over = {}) => ({ kind: 'runtime', status: 'active', ownerUserId: 'owner-1', ...over });

beforeEach(() => {
  mockIsAccountDeleting.mockReset().mockResolvedValue(false);
  mockMachineHasLiveAuthorization.mockReset().mockResolvedValue(true);
  mockParent.mockReset().mockReturnValue({ status: 'active' });
});

describe('runtimeCredentialRefusalReason', () => {
  test('a live runtime credential passes', async () => {
    expect(await runtimeCredentialRefusalReason(live({ parentId: 'p-1', machineId: 'm-1' }))).toBeNull();
  });

  test.each([
    ['a non-runtime credential', live({ kind: 'daemon' }), 'Invalid agent credential'],
    ['a revoked credential', live({ status: 'revoked' }), 'Token revoked'],
    ['an expired credential', live({ expiresAt: new Date(Date.now() - 1000) }), 'Session token expired'],
  ])('refuses %s', async (_label, credential, reason) => {
    expect(await runtimeCredentialRefusalReason(credential)).toBe(reason);
  });

  test('refuses while the owner is being deleted', async () => {
    mockIsAccountDeleting.mockResolvedValue(true);
    expect(await runtimeCredentialRefusalReason(live())).toBe('Credential owner is being deleted');
    expect(mockIsAccountDeleting).toHaveBeenCalledWith('owner-1');
  });

  test('refuses a child whose issuer is revoked or gone', async () => {
    mockParent.mockReturnValue({ status: 'revoked' });
    expect(await runtimeCredentialRefusalReason(live({ parentId: 'p-1' }))).toBe('Issuing credential revoked');
    mockParent.mockReturnValue(null);
    expect(await runtimeCredentialRefusalReason(live({ parentId: 'p-1' }))).toBe('Issuing credential revoked');
  });

  test('refuses a machine-bound credential once the machine is no longer authorized', async () => {
    mockMachineHasLiveAuthorization.mockResolvedValue(false);
    expect(await runtimeCredentialRefusalReason(live({ machineId: 'm-1' }))).toBe('Machine access revoked');
    expect(mockMachineHasLiveAuthorization).toHaveBeenCalledWith('m-1', 'owner-1');
  });
});

describe('embeddedRuntimeTokenExpired', () => {
  const holder = (expiresAt) => ({ agentRuntimeTokens: [{ tokenHash: 'h-1', expiresAt }, { tokenHash: 'h-2' }] });

  test('true only for the matching entry past its expiry', () => {
    expect(embeddedRuntimeTokenExpired(holder(new Date(Date.now() - 1000)), 'h-1')).toBe(true);
    expect(embeddedRuntimeTokenExpired(holder(new Date(Date.now() + 60_000)), 'h-1')).toBe(false);
    expect(embeddedRuntimeTokenExpired(holder(new Date(Date.now() - 1000)), 'h-2')).toBe(false);
    expect(embeddedRuntimeTokenExpired({}, 'h-1')).toBe(false);
  });
});
