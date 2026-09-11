const mockRoomGrant = { findOne: jest.fn() };
const mockPod = { findById: jest.fn() };
const mockToolCall = { create: jest.fn() };
const mockGithub = {
  listOpenIssues: jest.fn(),
  createIssue: jest.fn(),
  addIssueComment: jest.fn(),
  closeIssue: jest.fn(),
};
const mockReserveBudget = jest.fn();

jest.mock('../../../models/RoomGrant', () => ({ __esModule: true, default: mockRoomGrant }));
jest.mock('../../../models/Pod', () => ({ __esModule: true, default: mockPod }));
jest.mock('../../../models/ToolCall', () => ({
  __esModule: true,
  default: mockToolCall,
  // eslint-disable-next-line global-require
  digestArgs: (args) => require('crypto').createHash('sha256').update(JSON.stringify(args || {})).digest('hex'),
  reserveBudget: mockReserveBudget,
}));
jest.mock('../../../services/githubAppService', () => mockGithub);
jest.mock('../../../services/roomGrantService', () => {
  class MockRoomGrantError extends Error {
    constructor(code, message, statusCode = 400) {
      super(message);
      this.code = code;
      this.statusCode = statusCode;
    }
  }
  return {
    RoomGrantError: MockRoomGrantError,
    assertGrantUsable: jest.fn(async (options) => {
      if (!options.currentMemberIds.includes(options.agentUserId)) {
        throw new MockRoomGrantError('not_in_audience', 'agent is not in the grant audience', 403);
      }
      const rank = { read: 0, 'write-with-confirm': 1, write: 2 };
      if (rank[options.requiredWriteMode] > rank[options.grant.writeMode]) {
        throw new MockRoomGrantError('write_mode_not_allowed', 'write mode is too weak', 403);
      }
      return options.grant;
    }),
  };
});

// eslint-disable-next-line import/no-unresolved, import/extensions
const { callTool } = require('../../../services/toolBrokerService');
// eslint-disable-next-line import/no-unresolved, import/extensions
const { assertGrantUsable } = require('../../../services/roomGrantService');

const seatGrant = (overrides = {}) => ({
  grantId: 'grant-1',
  installationId: 'install-1',
  target: { kind: 'seat', id: 'agent-a' },
  tools: ['github.create_issue'],
  writeMode: 'read',
  audience: ['agent-a'],
  expiresAt: new Date(Date.now() + 60000),
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockToolCall.create.mockResolvedValue(undefined);
  mockGithub.listOpenIssues.mockResolvedValue([]);
  mockGithub.createIssue.mockResolvedValue({
    number: 1,
    title: 'test',
    html_url: 'https://github.com/Team-Commonly/commonly/issues/1',
  });
});

describe('tool broker guard rails', () => {
  it('takes required write mode from the server tool definition, never request input', async () => {
    mockRoomGrant.findOne.mockResolvedValue(seatGrant());
    await expect(callTool({
      grantId: 'grant-1',
      agentUserId: 'agent-a',
      tool: 'github.create_issue',
      args: { title: 'nope', writeMode: 'write' },
    })).rejects.toMatchObject({ code: 'write_mode_not_allowed' });
    expect(mockGithub.createIssue).not.toHaveBeenCalled();
    expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'refused',
      reason: 'write_mode_not_allowed',
      agentUserId: 'agent-a',
    }));
  });

  it('loads pod membership fresh for every grant usability assertion', async () => {
    const grant = seatGrant({
      grantId: 'pod-grant',
      target: { kind: 'pod', id: 'pod-1' },
      tools: ['github.list_issues'],
      writeMode: 'read',
      audience: ['agent-a'],
    });
    mockRoomGrant.findOne.mockResolvedValue(grant);
    let lookup = 0;
    mockPod.findById.mockImplementation(() => ({
      select: () => ({
        lean: async () => {
          lookup += 1;
          return { members: lookup === 1 ? ['agent-a'] : ['agent-b'] };
        },
      }),
    }));

    await expect(callTool({
      grantId: 'pod-grant', agentUserId: 'agent-a', tool: 'github.list_issues', args: {},
    }))
      .resolves.toEqual(expect.objectContaining({ result: { issues: [] } }));
    await expect(callTool({
      grantId: 'pod-grant', agentUserId: 'agent-a', tool: 'github.list_issues', args: {},
    }))
      .rejects.toMatchObject({ code: 'not_in_audience' });
    expect(mockPod.findById).toHaveBeenCalledTimes(2);
    expect(assertGrantUsable).toHaveBeenCalledTimes(2);
  });
});
