/**
 * TASK-783 (F163): a hosted agent, or a BYO seat a grant names, opens a GitHub
 * pull request through the broker. `prWrite` is the scope; every PR-write call
 * parks for the connection owner; heads live only on `seat/<agentUserId>/`; no
 * other GitHub write reaches these callers.
 *
 * The broker runs for real. Models, the approval store and GitHub sit behind
 * module mocks, so "nothing reached GitHub" is a mock with no calls.
 */
const mockRoomGrant = { findOne: jest.fn() };
const mockPod = { findById: jest.fn() };
const mockIntegration = { findOne: jest.fn(), findById: jest.fn() };
const mockToolCall = { create: jest.fn(), digestArgs: (args) => `digest:${JSON.stringify(args || {})}` };
const mockReserveBudgetLineage = jest.fn().mockResolvedValue(true);
const mockLineage = jest.fn();
jest.mock('../../../models/RoomGrant', () => ({ __esModule: true, default: mockRoomGrant }));
jest.mock('../../../models/Pod', () => ({ __esModule: true, default: mockPod }));
jest.mock('../../../models/Integration', () => ({ __esModule: true, default: mockIntegration }));
jest.mock('../../../models/ToolCall', () => ({
  __esModule: true, default: mockToolCall,
  digestArgs: mockToolCall.digestArgs,
  reserveBudgetLineage: mockReserveBudgetLineage,
}));
jest.mock('../../../services/githubAppService', () => ({
  createPullRequest: jest.fn(),
  createIssue: jest.fn(),
  listOpenIssues: jest.fn(),
  getBranchHead: jest.fn(),
  getCommitTree: jest.fn(),
  createTextTree: jest.fn(),
  createCommit: jest.fn(),
  createBranchRef: jest.fn(),
  fastForwardBranchRef: jest.fn(),
  getInstallationToken: jest.fn(),
}));
const mockProposeAction = jest.fn();
jest.mock('../../../services/approvalActionService', () => ({ proposeAction: (...args) => mockProposeAction(...args) }));
jest.mock('../../../services/dmService', () => ({ getOrCreateAgentRoom: jest.fn() }));
jest.mock('../../../services/brokerRecordService', () => ({ recordBrokerCall: jest.fn() }));
jest.mock('../../../services/outsiderGrantPodEligibility', () => ({
  outsiderGrantPodRefusal: jest.fn(async () => null),
  outsiderGrantRefusalMessage: jest.fn((reason) => `refused: ${reason}`),
}));
const mockSeatConfinement = jest.fn();
jest.mock('../../../services/seatGrantConfinement', () => ({
  judgeSeatConfinement: (...args) => mockSeatConfinement(...args),
}));
const mockNamingLifts = jest.fn();
jest.mock('../../../services/byoGrantNaming', () => ({
  byoPodExemptAgentIds: jest.fn(async () => []),
  namingLiftsFor: (...args) => mockNamingLifts(...args),
  namingLiftsRefusal: (refusal) => Boolean(refusal) && refusal.reason !== 'adapter_cannot_confine',
}));
jest.mock('../../../services/roomGrantService', () => {
  class MockRoomGrantError extends Error {
    constructor(code, message, statusCode = 400, details) {
      super(message); this.code = code; this.statusCode = statusCode; this.details = details;
    }
  }
  return {
    RoomGrantError: MockRoomGrantError,
    // The real tool and mode checks; the grant-level checks are the mock's.
    assertGrantToolAllowed: jest.requireActual('../../../services/roomGrantService').assertGrantToolAllowed,
    assertGrantUsable: jest.fn(async (options) => {
      if (!options.currentMemberIds.includes(options.agentUserId)) throw new MockRoomGrantError('not_in_audience', 'no', 403);
      jest.requireActual('../../../services/roomGrantService').assertGrantToolAllowed(options.grant, options);
    }),
    getGrantLineage: (...args) => mockLineage(...args),
  };
});

const github = require('../../../services/githubAppService');
const broker = require('../../../services/toolBrokerService');

const SEAT = 'aaaaaaaaaaaaaaaaaaaaaa01';
const OTHER_SEAT = 'aaaaaaaaaaaaaaaaaaaaaa02';
const OWNER = 'bbbbbbbbbbbbbbbbbbbbbb01';
const PARENT = '1'.repeat(40);
const GRANT_CREATED_AT = new Date('2026-01-02T00:00:00.000Z');
const ROW_CREATED_AT = new Date('2026-01-01T00:00:00.000Z');
const PR_TOOLS = ['github.get_issue', 'github.create_pull_request', 'github.commit_files', 'github.push_branch'];

const grant = (overrides = {}) => ({
  grantId: 'grant-pr', connectionId: 'gh-1', installationId: 'gh-1',
  target: { kind: 'pod', id: 'pod-1' }, tools: PR_TOOLS, writeMode: 'write-with-confirm', prWrite: true,
  audience: [SEAT], expiresAt: new Date(Date.now() + 86400000), createdAt: GRANT_CREATED_AT,
  ...overrides,
});

const prArgs = (over = {}) => ({ title: 'Fix #12', head: `seat/${SEAT}/fix-12`, base: 'main', body: 'Closes #12', ...over });
const commitArgs = (over = {}) => ({
  branch: `seat/${SEAT}/fix-12`, base: 'main', message: 'Fix #12',
  files: [{ path: 'src/a.js', content: 'export const a = 1;\n' }], ...over,
});
const hosted = (tool, args, over = {}) => broker.callTool({
  grantId: 'grant-pr', agentUserId: SEAT, agentName: 'helper', instanceId: 'default',
  tool, args, hostedTurn: true, ...over,
});
const parked = () => mockProposeAction.mock.calls.at(-1)[0].toolCall;
const runParked = (toolCall = parked()) => broker.executeApprovedToolCall({
  grantId: toolCall.grantId, agentUserId: SEAT, tool: toolCall.tool,
  args: toolCall.canonicalArgs, expectedArgsDigest: toolCall.argsDigest, approvalId: 'approval-1',
  // As approvalActionService passes it: from the parked envelope.
  callerConfinement: toolCall.callerConfinement,
});
const nothingReachedGithub = () => {
  for (const fn of Object.values(github)) expect(fn).not.toHaveBeenCalled();
};

let current;
beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.SEAT_GITHUB_PUSH_ENABLED;
  current = grant();
  mockRoomGrant.findOne.mockImplementation(async () => current);
  mockLineage.mockImplementation(async (g) => [g]);
  mockPod.findById.mockReturnValue({ select: () => ({ lean: async () => ({ members: [SEAT, OWNER] }) }) });
  mockIntegration.findOne.mockResolvedValue({
    type: 'github-app', status: 'connected', createdBy: OWNER, createdAt: ROW_CREATED_AT,
    config: { installationId: 'gh-1', owner: 'Team-Commonly', repo: 'commonly' },
  });
  mockProposeAction.mockResolvedValue({ ok: true, approvalId: 'approval-1' });
  mockSeatConfinement.mockResolvedValue({ refusal: null, scope: 'seat' });
  mockNamingLifts.mockResolvedValue(false);
  github.getBranchHead.mockImplementation(async ({ branch }) => (branch === 'main' ? PARENT : null));
  github.getCommitTree.mockResolvedValue('tree-parent');
  github.createTextTree.mockResolvedValue('tree-new');
  github.createCommit.mockResolvedValue('2'.repeat(40));
  github.createPullRequest.mockResolvedValue({ number: 77, html_url: 'https://github.com/x/y/pull/77' });
});

describe('the scope', () => {
  test('a grant without prWrite refuses create_pull_request, before parking or GitHub', async () => {
    current = grant({ prWrite: undefined });
    await expect(hosted('github.create_pull_request', prArgs())).rejects.toMatchObject({ code: 'pr_write_not_granted' });
    expect(mockProposeAction).not.toHaveBeenCalled();
    nothingReachedGithub();
    expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'refused', reason: 'pr_write_not_granted', tool: 'github.create_pull_request',
    }));
  });

  test('only `true` holds it: a truthy string does not', async () => {
    current = grant({ prWrite: 'true' });
    await expect(hosted('github.commit_files', commitArgs())).rejects.toMatchObject({ code: 'pr_write_not_granted' });
  });

  test('a parent without prWrite refuses its child\'s PR call', async () => {
    const parent = grant({ grantId: 'grant-parent', prWrite: undefined });
    mockLineage.mockImplementation(async (g) => [g, parent]);
    await expect(hosted('github.create_pull_request', prArgs())).rejects.toMatchObject({ code: 'pr_write_not_granted' });
    expect(mockProposeAction).not.toHaveBeenCalled();
  });

  test('an approval parked before the scope went away does not run', async () => {
    await expect(hosted('github.create_pull_request', prArgs())).rejects.toMatchObject({ code: 'approval_required' });
    current = grant({ prWrite: undefined });
    await expect(runParked()).rejects.toMatchObject({ code: 'pr_write_not_granted' });
    nothingReachedGithub();
  });

  test('the MCP list offers the PR tools only on a prWrite grant', async () => {
    const names = async () => (await broker.listToolsForGrant({ grantId: 'grant-pr', agentUserId: SEAT }))
      .map((d) => d.name);
    expect(await names()).toEqual(expect.arrayContaining(['github.create_pull_request', 'github.commit_files']));
    current = grant({ prWrite: undefined });
    expect(await names()).toEqual(['github.get_issue']);
  });
});

describe('every call parks', () => {
  test('create_pull_request parks with the pinned args and nothing reaches GitHub', async () => {
    await expect(hosted('github.create_pull_request', prArgs())).rejects.toMatchObject({
      code: 'approval_required', details: { approvalId: 'approval-1' },
    });
    expect(parked()).toMatchObject({
      grantId: 'grant-pr', tool: 'github.create_pull_request',
      canonicalArgs: { ...prArgs(), owner: 'Team-Commonly', repo: 'commonly' },
    });
    expect(mockProposeAction.mock.calls[0][0]).toMatchObject({ ownerUserId: OWNER, agentUserId: SEAT });
    nothingReachedGithub();
    expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'pending_approval', approvalId: 'approval-1', callerConfinement: 'hosted',
    }));
  });

  // The floor is the definition's, not the grant's: a row that says `write`
  // (the mint refuses it; the outsider gate refuses it) still parks.
  test.each(['github.create_pull_request', 'github.commit_files', 'github.push_branch'])(
    '%s parks on a grant whose mode would run writes unattended', async (tool) => {
      process.env.SEAT_GITHUB_PUSH_ENABLED = 'true';
      current = grant({ writeMode: 'write' });
      const args = {
        'github.create_pull_request': prArgs(),
        'github.commit_files': commitArgs(),
        'github.push_branch': {
          ref: `refs/heads/seat/${SEAT}/fix-12`, baseOid: PARENT, newOid: '3'.repeat(40), bundle: 'AAAA',
        },
      }[tool];
      await expect(broker.callTool({ grantId: 'grant-pr', agentUserId: SEAT, tool, args }))
        .rejects.toMatchObject({ code: 'approval_required' });
      expect(github.createPullRequest).not.toHaveBeenCalled();
      expect(github.createCommit).not.toHaveBeenCalled();
      expect(github.getInstallationToken).not.toHaveBeenCalled();
    },
  );

  test('the tool result tells a hosted agent it is waiting and how it learns the outcome', async () => {
    const { dispatchHostedBrokerTool } = require('../../../services/grantBrokerProjectionService');
    const answer = await dispatchHostedBrokerTool({
      projection: { tools: [], dispatch: new Map([['github_create_pull_request', { grantId: 'grant-pr', tool: 'github.create_pull_request' }]]) },
      name: 'github_create_pull_request', args: prArgs(), agentUserId: SEAT,
    });
    expect(answer).toMatchObject({
      outcome: 'pending_approval',
      content: { status: 'pending_approval', approvalId: 'approval-1', message: expect.stringContaining('approval.resolved') },
    });
    nothingReachedGithub();
  });
});

describe('the approved call', () => {
  test('runs exactly the parked arguments once', async () => {
    await expect(hosted('github.create_pull_request', prArgs())).rejects.toMatchObject({ code: 'approval_required' });
    await expect(runParked()).resolves.toMatchObject({ outcome: 'ok', receipt: { number: 77 } });
    expect(github.createPullRequest).toHaveBeenCalledTimes(1);
    expect(github.createPullRequest).toHaveBeenCalledWith(expect.objectContaining({
      owner: 'Team-Commonly', repo: 'commonly', installationId: 'gh-1', forceApp: true,
      title: 'Fix #12', head: `seat/${SEAT}/fix-12`, base: 'main', body: 'Closes #12',
    }));
    expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'ok', approvalId: 'approval-1', tool: 'github.create_pull_request',
    }));
  });

  test('an envelope edited after parking does not run', async () => {
    await expect(hosted('github.create_pull_request', prArgs())).rejects.toMatchObject({ code: 'approval_required' });
    const call = parked();
    await expect(runParked({ ...call, canonicalArgs: { ...call.canonicalArgs, head: `seat/${OTHER_SEAT}/x` } }))
      .rejects.toMatchObject({ code: 'args_digest_mismatch' });
    nothingReachedGithub();
  });
});

describe('heads belong to the calling seat', () => {
  test.each([
    ['main', 'main'],
    ['another seat\'s branch', `seat/${OTHER_SEAT}/fix-12`],
    ['the bare prefix', `seat/${SEAT}`],
    ['a traversal', `seat/${SEAT}/../main`],
    ['a prefix lookalike', `seat/${SEAT}x/fix`],
  ])('create_pull_request refuses %s before parking', async (_label, head) => {
    await expect(hosted('github.create_pull_request', prArgs({ head })))
      .rejects.toMatchObject({ code: 'branch_not_owned_by_seat' });
    expect(mockProposeAction).not.toHaveBeenCalled();
    nothingReachedGithub();
  });

  test('commit_files refuses another seat\'s branch before parking', async () => {
    await expect(hosted('github.commit_files', commitArgs({ branch: `seat/${OTHER_SEAT}/fix-12` })))
      .rejects.toMatchObject({ code: 'branch_not_owned_by_seat' });
    expect(mockProposeAction).not.toHaveBeenCalled();
    nothingReachedGithub();
  });

  test('the executor re-checks the head against the seat the call was parked for', async () => {
    await expect(hosted('github.create_pull_request', prArgs())).rejects.toMatchObject({ code: 'approval_required' });
    const call = parked();
    current = grant({ audience: [SEAT, OTHER_SEAT] });
    mockPod.findById.mockReturnValue({ select: () => ({ lean: async () => ({ members: [SEAT, OTHER_SEAT, OWNER] }) }) });
    await expect(broker.executeApprovedToolCall({
      grantId: call.grantId, agentUserId: OTHER_SEAT, tool: call.tool,
      args: call.canonicalArgs, expectedArgsDigest: call.argsDigest, approvalId: 'approval-1',
      callerConfinement: call.callerConfinement,
    })).rejects.toMatchObject({ code: 'branch_not_owned_by_seat' });
    expect(github.createPullRequest).not.toHaveBeenCalled();
  });
});

describe('no other GitHub write', () => {
  test('a named seat is refused any other write, whatever the grant says', async () => {
    current = grant({ tools: ['github.create_issue'], prWrite: undefined });
    mockSeatConfinement.mockResolvedValue({ refusal: { reason: 'sandbox_absent', detail: 'no sandbox' }, scope: 'seat' });
    mockNamingLifts.mockResolvedValue(true);
    await expect(broker.callTool({ grantId: 'grant-pr', agentUserId: SEAT, agentName: 'lily-claude', tool: 'github.create_issue', args: { title: 'x' } }))
      .rejects.toMatchObject({ code: 'write_tool_not_permitted' });
    expect(mockProposeAction).not.toHaveBeenCalled();
  });

  test('a prWrite grant runs no other write, for any caller', async () => {
    current = grant({ tools: [...PR_TOOLS, 'github.create_issue'] });
    await expect(broker.callTool({ grantId: 'grant-pr', agentUserId: SEAT, tool: 'github.create_issue', args: { title: 'x' } }))
      .rejects.toMatchObject({ code: 'write_tool_not_permitted' });
    expect(mockProposeAction).not.toHaveBeenCalled();
  });

  test('a grant that names a BYO seat runs no other write, for any caller', async () => {
    current = grant({ tools: ['github.create_issue'], prWrite: undefined, byoConsent: { by: OWNER }, byoAgents: [SEAT] });
    await expect(broker.callTool({ grantId: 'grant-pr', agentUserId: SEAT, tool: 'github.create_issue', args: { title: 'x' } }))
      .rejects.toMatchObject({ code: 'write_tool_not_permitted' });
  });

  test('reads still run on a prWrite grant', async () => {
    github.listOpenIssues.mockResolvedValue([]);
    current = grant({ tools: ['github.list_issues', 'github.create_pull_request'] });
    await expect(hosted('github.list_issues', {})).resolves.toMatchObject({ outcome: 'ok' });
  });
});

describe('BYO seats', () => {
  test('a seat the grant names, otherwise refused for its sandbox, may park a PR', async () => {
    mockSeatConfinement.mockResolvedValue({ refusal: { reason: 'sandbox_absent', detail: 'no sandbox' }, scope: 'seat' });
    mockNamingLifts.mockResolvedValue(true);
    await expect(broker.callTool({
      grantId: 'grant-pr', agentUserId: SEAT, agentName: 'lily-claude', tool: 'github.create_pull_request', args: prArgs(),
    })).rejects.toMatchObject({ code: 'approval_required' });
    expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'pending_approval', callerConfinement: 'named_unconfined',
    }));
    nothingReachedGithub();
  });

  test('an unnamed seat with no sandbox is refused before anything parks', async () => {
    mockSeatConfinement.mockResolvedValue({ refusal: { reason: 'sandbox_absent', detail: 'no sandbox' }, scope: 'seat' });
    await expect(broker.callTool({
      grantId: 'grant-pr', agentUserId: SEAT, agentName: 'lily-claude', tool: 'github.create_pull_request', args: prArgs(),
    })).rejects.toMatchObject({ code: 'grant_broker_unconfined', details: expect.objectContaining({ reason: 'sandbox_absent' }) });
    expect(mockProposeAction).not.toHaveBeenCalled();
  });

  test('naming never lifts an adapter that cannot confine', async () => {
    mockSeatConfinement.mockResolvedValue({ refusal: { reason: 'adapter_cannot_confine', detail: 'no' }, scope: 'seat' });
    mockNamingLifts.mockResolvedValue(true);
    await expect(broker.callTool({
      grantId: 'grant-pr', agentUserId: SEAT, agentName: 'lily-claude', tool: 'github.create_pull_request', args: prArgs(),
    })).rejects.toMatchObject({ code: 'grant_broker_unconfined' });
    expect(mockProposeAction).not.toHaveBeenCalled();
  });

  test('confinement is judged on every call, not once per grant', async () => {
    mockSeatConfinement.mockResolvedValueOnce({ refusal: null, scope: 'seat' })
      .mockResolvedValueOnce({ refusal: { reason: 'sandbox_absent', detail: 'gone' }, scope: 'seat' });
    const call = () => broker.callTool({
      grantId: 'grant-pr', agentUserId: SEAT, agentName: 'lily-claude', tool: 'github.create_pull_request', args: prArgs(),
    });
    await expect(call()).rejects.toMatchObject({ code: 'approval_required' });
    await expect(call()).rejects.toMatchObject({ code: 'grant_broker_unconfined' });
    expect(mockSeatConfinement).toHaveBeenCalledTimes(2);
    expect(mockProposeAction).toHaveBeenCalledTimes(1);
  });
});

describe('github.commit_files', () => {
  test('parks with the parent the commit will sit on, read now from the base', async () => {
    await expect(hosted('github.commit_files', commitArgs())).rejects.toMatchObject({ code: 'approval_required' });
    expect(parked().canonicalArgs).toEqual({
      ...commitArgs(), parentSha: PARENT, branchExists: false, owner: 'Team-Commonly', repo: 'commonly',
    });
    expect(github.createCommit).not.toHaveBeenCalled();
    expect(github.createBranchRef).not.toHaveBeenCalled();
  });

  test('an agent cannot supply the parent itself', async () => {
    await expect(hosted('github.commit_files', commitArgs({ parentSha: '9'.repeat(40) })))
      .rejects.toMatchObject({ code: 'invalid_tool_args' });
    expect(mockProposeAction).not.toHaveBeenCalled();
  });

  test.each(['.github/workflows/ci.yml', '.GitHub/actions/x/action.yml', 'docs/CODEOWNERS', '.github'])(
    'refuses protected path %s before parking', async (path) => {
      await expect(hosted('github.commit_files', commitArgs({ files: [{ path, content: 'x' }] })))
        .rejects.toMatchObject({ code: 'push_protected_path' });
      expect(mockProposeAction).not.toHaveBeenCalled();
    },
  );

  test.each(['../etc/passwd', '/abs', 'a/.git/config', 'a//b', 'a\\b', 'a/./b'])(
    'refuses path %s', async (path) => {
      await expect(hosted('github.commit_files', commitArgs({ files: [{ path, content: 'x' }] })))
        .rejects.toMatchObject({ code: 'invalid_tool_args' });
    },
  );

  test('approval creates the branch at the approved parent with exactly the approved files', async () => {
    await expect(hosted('github.commit_files', commitArgs())).rejects.toMatchObject({ code: 'approval_required' });
    github.getBranchHead.mockClear();
    await expect(runParked()).resolves.toMatchObject({ outcome: 'ok' });
    expect(github.getCommitTree).toHaveBeenCalledWith(expect.objectContaining({ sha: PARENT }));
    expect(github.createTextTree).toHaveBeenCalledWith(expect.objectContaining({
      baseTree: 'tree-parent', files: commitArgs().files,
    }));
    expect(github.createCommit).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Fix #12', tree: 'tree-new', parents: [PARENT],
    }));
    expect(github.createBranchRef).toHaveBeenCalledWith(expect.objectContaining({
      branch: `seat/${SEAT}/fix-12`, sha: '2'.repeat(40), installationId: 'gh-1',
    }));
    expect(github.fastForwardBranchRef).not.toHaveBeenCalled();
  });

  test('an existing seat branch continues from its tip and only fast-forwards', async () => {
    const tip = '4'.repeat(40);
    github.getBranchHead.mockImplementation(async ({ branch }) => (branch === 'main' ? PARENT : tip));
    await expect(hosted('github.commit_files', commitArgs())).rejects.toMatchObject({ code: 'approval_required' });
    expect(parked().canonicalArgs).toMatchObject({ parentSha: tip, branchExists: true });
    await expect(runParked()).resolves.toMatchObject({ outcome: 'ok' });
    expect(github.fastForwardBranchRef).toHaveBeenCalledWith(expect.objectContaining({ sha: '2'.repeat(40) }));
    expect(github.createBranchRef).not.toHaveBeenCalled();
  });

  test('a branch that moved after approval was asked for refuses, writing nothing', async () => {
    await expect(hosted('github.commit_files', commitArgs())).rejects.toMatchObject({ code: 'approval_required' });
    github.getBranchHead.mockImplementation(async () => '5'.repeat(40));
    await expect(runParked()).rejects.toMatchObject({ code: 'stale_branch' });
    expect(github.createCommit).not.toHaveBeenCalled();
    expect(github.createBranchRef).not.toHaveBeenCalled();
  });

  test('a ref write GitHub refuses as a race reads stale_branch', async () => {
    await expect(hosted('github.commit_files', commitArgs())).rejects.toMatchObject({ code: 'approval_required' });
    github.createBranchRef.mockRejectedValue(Object.assign(new Error('exists'), { response: { status: 422 } }));
    await expect(runParked()).rejects.toMatchObject({ code: 'stale_branch' });
  });
});

describe('the hosted projection', () => {
  const RoomGrantModel = require('../../../models/RoomGrant');
  test('offers the hosted PR writes only on a prWrite grant, and never push_branch', async () => {
    const { hostedBrokerToolsForRun } = require('../../../services/grantBrokerProjectionService');
    process.env.SEAT_GITHUB_PUSH_ENABLED = 'true';
    const rows = [];
    RoomGrantModel.default.find = jest.fn(() => ({ select: () => ({ lean: async () => rows }) }));
    mockPod.find = jest.fn(() => ({ select: () => ({ lean: async () => [{ _id: 'aaaaaaaaaaaaaaaaaaaaaa99', members: [SEAT] }] }) }));
    const target = { kind: 'pod', id: 'aaaaaaaaaaaaaaaaaaaaaa99' };
    rows.push({ ...grant({ target }) });
    let names = (await hostedBrokerToolsForRun({ identityId: SEAT, podId: target.id })).tools.map((t) => t.function.name);
    expect(names.sort()).toEqual(['github_commit_files', 'github_create_pull_request', 'github_get_issue']);
    rows[0] = { ...grant({ target, prWrite: undefined }) };
    names = (await hostedBrokerToolsForRun({ identityId: SEAT, podId: target.id })).tools.map((t) => t.function.name);
    expect(names).toEqual(['github_get_issue']);
  });
});

describe('the approved call is judged again before it runs', () => {
  const runParkedAs = (callerConfinement) => {
    const call = parked();
    return broker.executeApprovedToolCall({
      grantId: call.grantId, agentUserId: SEAT, tool: call.tool, args: call.canonicalArgs,
      expectedArgsDigest: call.argsDigest, approvalId: 'approval-1',
      callerConfinement, agentName: 'lily-claude', instanceId: 'default',
    });
  };

  test('the parked envelope records how the caller was judged', async () => {
    await expect(hosted('github.create_pull_request', prArgs())).rejects.toMatchObject({ code: 'approval_required' });
    expect(parked().callerConfinement).toBe('hosted');
  });

  test('a hosted call runs without a seat judgement: a hosted turn has nothing to confine', async () => {
    await expect(hosted('github.create_pull_request', prArgs())).rejects.toMatchObject({ code: 'approval_required' });
    mockSeatConfinement.mockClear();
    await expect(runParkedAs('hosted')).resolves.toMatchObject({ outcome: 'ok' });
    expect(mockSeatConfinement).not.toHaveBeenCalled();
  });

  test('a PR write with no recorded judgement refuses: fail closed', async () => {
    await expect(hosted('github.create_pull_request', prArgs())).rejects.toMatchObject({ code: 'approval_required' });
    await expect(runParkedAs(undefined)).rejects.toMatchObject({ code: 'confinement_changed' });
    nothingReachedGithub();
  });

  test('a named seat whose naming no longer lifts its refusal does not run', async () => {
    mockSeatConfinement.mockResolvedValue({ refusal: { reason: 'sandbox_absent', detail: 'no' }, scope: 'seat' });
    mockNamingLifts.mockResolvedValue(true);
    await expect(broker.callTool({
      grantId: 'grant-pr', agentUserId: SEAT, agentName: 'lily-claude', tool: 'github.create_pull_request', args: prArgs(),
    })).rejects.toMatchObject({ code: 'approval_required' });
    expect(parked().callerConfinement).toBe('named_unconfined');
    mockNamingLifts.mockResolvedValue(false);
    await expect(runParkedAs('named_unconfined')).rejects.toMatchObject({ code: 'confinement_changed' });
    nothingReachedGithub();
    expect(mockToolCall.create).toHaveBeenLastCalledWith(expect.objectContaining({
      outcome: 'refused', reason: 'confinement_changed', approvalId: 'approval-1',
    }));
  });

  test('a seat judged again now runs when nothing changed', async () => {
    await expect(broker.callTool({
      grantId: 'grant-pr', agentUserId: SEAT, agentName: 'lily-claude', tool: 'github.create_pull_request', args: prArgs(),
    })).rejects.toMatchObject({ code: 'approval_required' });
    await expect(runParkedAs('confined')).resolves.toMatchObject({ outcome: 'ok' });
    expect(mockSeatConfinement).toHaveBeenLastCalledWith(expect.objectContaining({
      agentUserId: SEAT, agentName: 'lily-claude', instanceId: 'default',
    }));
  });
});
