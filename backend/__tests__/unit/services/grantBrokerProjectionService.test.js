/* eslint-disable global-require, import/no-unresolved, import/extensions --
   the requires must follow jest.mock, and this corpus resolves TS through the TS parser */
// Row B (TASK-132): the shared grant selection, and the hosted projection built
// from it.
//
// Two things are being pinned here rather than in the runtime test:
//   - the SELECTION arms (seat target, pod target with current membership,
//     another pod, another seat, outside the audience) — the daemon and a hosted
//     run must agree on every one of them, and this module is now the only place
//     that decides;
//   - the QUERY, because revoke and expiry are enforced there rather than in a
//     stored projection. A selection that read the grant document and filtered
//     in JS would look identical today and drift on the next change.
const mockRoomGrant = { find: jest.fn() };
const mockPod = { find: jest.fn() };
const mockCallTool = jest.fn();

jest.mock('../../../models/RoomGrant', () => ({ __esModule: true, default: mockRoomGrant }));
jest.mock('../../../models/Pod', () => ({ __esModule: true, default: mockPod }));
jest.mock('../../../services/toolBrokerService', () => ({
  ...jest.requireActual('../../../services/toolBrokerService'),
  callTool: (...args) => mockCallTool(...args),
}));

const {
  GRANT_BROKER_TOOL_NAME_PATTERN,
  sanitizeGrantBrokerToolName,
  selectLiveGrantsForIdentities,
  hostedBrokerToolsForRun,
  dispatchHostedBrokerTool,
} = require('../../../services/grantBrokerProjectionService');
const { GRANT_BROKER_ID } = require('../../../services/installable/toolInstallables');

const POD_A = '507f1f77bcf86cd799439011';
const POD_B = '507f1f77bcf86cd799439012';
const SEAT = '507f1f77bcf86cd799439013';
const OTHER_SEAT = '507f1f77bcf86cd799439014';

const seatGrant = (overrides = {}) => ({
  grantId: 'grant-seat',
  target: { kind: 'seat', id: SEAT },
  audience: [SEAT],
  tools: ['github.list_issues'],
  writeMode: 'read',
  ...overrides,
});

const podGrant = (overrides = {}) => ({
  grantId: 'grant-pod',
  target: { kind: 'pod', id: POD_A },
  audience: [SEAT],
  tools: ['github.list_issues'],
  writeMode: 'read',
  ...overrides,
});

const grantQuery = (rows, pods = [{ _id: POD_A, members: [SEAT] }]) => {
  mockRoomGrant.find.mockReturnValue({ select: () => ({ lean: async () => rows }) });
  mockPod.find.mockReturnValue({ select: () => ({ lean: async () => pods }) });
};

beforeEach(() => {
  jest.clearAllMocks();
  grantQuery([]);
});

describe('selectLiveGrantsForIdentities', () => {
  test('the revoke and expiry filters stay in the query, not in a stored projection', async () => {
    grantQuery([]);
    await selectLiveGrantsForIdentities({ identityIds: [SEAT], podIds: [POD_A] });

    expect(mockRoomGrant.find).toHaveBeenCalledWith({
      brokerId: GRANT_BROKER_ID,
      revokedAt: null,
      expiresAt: { $gt: expect.any(Date) },
      audience: { $in: [SEAT] },
    });
  });

  test('a seat-targeted grant reaches the seat it names, and only that seat', async () => {
    grantQuery([
      seatGrant(),
      seatGrant({ grantId: 'grant-other-seat', target: { kind: 'seat', id: OTHER_SEAT } }),
    ]);
    const map = await selectLiveGrantsForIdentities({ identityIds: [SEAT], podIds: [POD_A] });
    expect(map.get(SEAT).map((g) => g.grantId)).toEqual(['grant-seat']);
  });

  test('a pod-targeted grant needs CURRENT membership, not just the mint-time audience', async () => {
    grantQuery([podGrant()], [{ _id: POD_A, members: [SEAT] }]);
    const member = await selectLiveGrantsForIdentities({ identityIds: [SEAT], podIds: [POD_A] });
    expect(member.get(SEAT).map((g) => g.grantId)).toEqual(['grant-pod']);

    // Same grant, same audience, seat no longer in the pod: nothing.
    grantQuery([podGrant()], [{ _id: POD_A, members: [OTHER_SEAT] }]);
    const left = await selectLiveGrantsForIdentities({ identityIds: [SEAT], podIds: [POD_A] });
    expect(left.has(SEAT)).toBe(false);
  });

  test('a grant targeting another pod is never projected, even from an audience member', async () => {
    grantQuery([podGrant({ target: { kind: 'pod', id: POD_B } })]);
    const map = await selectLiveGrantsForIdentities({ identityIds: [SEAT], podIds: [POD_A] });
    expect(map.size).toBe(0);
  });

  test('a seat outside the grant audience is excluded before any target check', async () => {
    grantQuery([seatGrant({ audience: [OTHER_SEAT] })]);
    const map = await selectLiveGrantsForIdentities({ identityIds: [SEAT], podIds: [POD_A] });
    expect(map.size).toBe(0);
  });

  test('seats with nothing live are absent from the map, not mapped to an empty list', async () => {
    grantQuery([seatGrant()]);
    const map = await selectLiveGrantsForIdentities({
      identityIds: [SEAT, OTHER_SEAT],
      podIds: [POD_A],
    });
    expect(map.has(SEAT)).toBe(true);
    expect(map.has(OTHER_SEAT)).toBe(false);
  });
});

describe('hostedBrokerToolsForRun', () => {
  test('offers the read tools the grant names, under function-name-safe names', async () => {
    grantQuery([seatGrant({
      tools: ['github.list_issues', 'github.get_issue', 'github.create_issue'],
    })]);
    const { tools, dispatch } = await hostedBrokerToolsForRun({ identityId: SEAT, podId: POD_A });

    expect(tools.map((tool) => tool.function.name)).toEqual(['github_list_issues', 'github_get_issue']);
    expect(dispatch.get('github_list_issues')).toEqual({ grantId: 'grant-seat', tool: 'github.list_issues' });
    expect(tools[0].function.parameters).toBe(
      jest.requireActual('../../../services/toolBrokerService').TOOL_DEFINITIONS['github.list_issues'].inputSchema,
    );
    // The dot the broker uses is not a legal function name — that is the whole
    // reason the exposure is renamed rather than passed through.
    expect(GRANT_BROKER_TOOL_NAME_PATTERN.test('github.list_issues')).toBe(false);
    expect(sanitizeGrantBrokerToolName('github.list_issues')).toBe('github_list_issues');
  });

  test('a write tool is not offered even when the grant would allow it (reads only, v1)', async () => {
    grantQuery([seatGrant({
      writeMode: 'write',
      tools: ['github.list_issues', 'github.create_issue', 'github.merge_pull_request'],
    })]);
    const { tools, dispatch } = await hostedBrokerToolsForRun({ identityId: SEAT, podId: POD_A });
    expect(tools.map((tool) => tool.function.name)).toEqual(['github_list_issues']);
    expect(dispatch.has('github_create_issue')).toBe(false);
  });

  test('the grant tools list is the boundary: an unlisted read tool stays unoffered', async () => {
    grantQuery([seatGrant({ tools: ['github.get_pull_request'] })]);
    const { tools } = await hostedBrokerToolsForRun({ identityId: SEAT, podId: POD_A });
    expect(tools.map((tool) => tool.function.name)).toEqual(['github_get_pull_request']);
  });

  test('two live grants covering one tool expose it once, from the same grant every time', async () => {
    grantQuery([
      seatGrant({ grantId: 'grant-z', tools: ['github.list_issues'] }),
      seatGrant({ grantId: 'grant-a', tools: ['github.list_issues'] }),
    ]);
    const { tools, dispatch } = await hostedBrokerToolsForRun({ identityId: SEAT, podId: POD_A });
    expect(tools.map((tool) => tool.function.name)).toEqual(['github_list_issues']);
    expect(dispatch.get('github_list_issues').grantId).toBe('grant-a');
  });

  test('no live grant means no broker tools, and no map to dispatch into', async () => {
    grantQuery([]);
    const { tools, dispatch } = await hostedBrokerToolsForRun({ identityId: SEAT, podId: POD_A });
    expect(tools).toEqual([]);
    expect(dispatch.size).toBe(0);
  });
});

describe('dispatchHostedBrokerTool', () => {
  const projection = {
    tools: [],
    dispatch: new Map([['github_list_issues', { grantId: 'grant-seat', tool: 'github.list_issues' }]]),
  };

  test('a name that is not a broker tool falls through to the runtime', async () => {
    const call = await dispatchHostedBrokerTool({
      projection,
      name: 'commonly_read_context',
      args: {},
      agentUserId: SEAT,
    });
    expect(call).toBeNull();
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  test('the mapped grant and tool are used, so a forged id in the arguments decides nothing', async () => {
    mockCallTool.mockResolvedValue({ callId: 'tool_call_1', result: [{ number: 7 }] });
    const call = await dispatchHostedBrokerTool({
      projection,
      name: 'github_list_issues',
      // Pod content is untrusted: both ids here are attacker-chosen and neither
      // is consulted — the agent identity comes from the run, the grant from the
      // projection.
      args: { grantId: 'grant-someone-else', agentUserId: OTHER_SEAT, state: 'open' },
      agentUserId: SEAT,
      agentName: 'kai',
      instanceId: 'default',
    });

    expect(mockCallTool).toHaveBeenCalledWith({
      grantId: 'grant-seat',
      agentUserId: SEAT,
      agentName: 'kai',
      instanceId: 'default',
      tool: 'github.list_issues',
      args: { grantId: 'grant-someone-else', agentUserId: OTHER_SEAT, state: 'open' },
    });
    expect(call).toEqual({ content: [{ number: 7 }], callId: 'tool_call_1', outcome: 'ok' });
  });

  test('a refusal carries the broker row id and the same payload shape MCP sends', async () => {
    const refusal = Object.assign(new Error('grant is revoked'), {
      code: 'grant_revoked',
      details: { recorded: true, callId: 'tool_call_refused' },
    });
    mockCallTool.mockRejectedValue(refusal);
    const call = await dispatchHostedBrokerTool({
      projection,
      name: 'github_list_issues',
      args: {},
      agentUserId: SEAT,
    });
    expect(call).toEqual({
      content: {
        error: 'grant_revoked',
        message: 'grant is revoked',
        details: { recorded: true, callId: 'tool_call_refused' },
      },
      callId: 'tool_call_refused',
      outcome: 'refused',
    });
  });

  test('an approval park is reported as pending_approval, not as a failure', async () => {
    mockCallTool.mockRejectedValue(Object.assign(new Error('tool call requires approval'), {
      code: 'approval_required',
      details: { approvalId: 'approval-9', callId: 'tool_call_parked', recorded: true },
    }));
    const call = await dispatchHostedBrokerTool({
      projection,
      name: 'github_list_issues',
      args: {},
      agentUserId: SEAT,
    });
    expect(call).toEqual({
      content: { status: 'pending_approval', approvalId: 'approval-9' },
      callId: 'tool_call_parked',
      outcome: 'pending_approval',
    });
  });

  test('an unexpected throw is a failure, not a refusal', async () => {
    mockCallTool.mockRejectedValue(new Error('socket hang up'));
    const call = await dispatchHostedBrokerTool({
      projection,
      name: 'github_list_issues',
      args: {},
      agentUserId: SEAT,
    });
    expect(call.outcome).toBe('failed');
    expect(call.content.error).toBe('broker_error');
    expect(call.callId).toBeUndefined();
  });
});
