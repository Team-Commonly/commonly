const request = require('supertest');
const express = require('express');

const mockOwner = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const mockOther = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const mockInstallation = '111111111111111111111111';
let mockViewer = mockOwner;
let mockInstalledBy = mockOwner;
let mockDeclared = true;
let mockEnabled = true;
let mockRuntime = { runtimeType: 'native' };
let mockHosted;

jest.mock('express-rate-limit', () => ({ __esModule: true, default: () => (_req, _res, next) => next() }));
jest.mock('../../../middleware/auth', () => (req, _res, next) => { req.userId = mockViewer; next(); });
jest.mock('../../../models/User', () => ({
  findById: () => ({ select: () => ({ lean: async () => ({ isBot: false }) }) }),
}));
const mockInstallationRow = () => ({
  _id: mockInstallation,
  config: {
    runtime: mockRuntime,
    ...(mockHosted ? { hosted: mockHosted } : {}),
    tools: mockDeclared ? ['computer_request_takeover'] : [],
  },
});
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: {
    findOne: (query) => ({
      select: () => ({
        lean: async () => (String(query.installedBy) === mockInstalledBy ? mockInstallationRow() : null),
      }),
    }),
  },
}));

const mockBroker = {
  takeoverStatus: jest.fn(async () => ({ active: true, url: 'https://www.linkedin.com/messaging/' })),
  humanScreenshot: jest.fn(async () => Buffer.from('png')),
  humanClick: jest.fn(async () => {}),
  humanType: jest.fn(async () => {}),
  humanPress: jest.fn(async () => {}),
  decideWrite: jest.fn(async () => {}),
  handBack: jest.fn(async () => {}),
};
jest.mock('../../../services/agentComputerBroker', () => ({
  agentComputerEnabled: () => mockEnabled,
  agentComputerBroker: mockBroker,
}));

const app = express();
app.use(express.json());
app.use('/api/agent-computer', require('../../../routes/agentComputer'));

beforeEach(() => {
  mockViewer = mockOwner;
  mockInstalledBy = mockOwner;
  mockDeclared = true;
  mockEnabled = true;
  mockRuntime = { runtimeType: 'native' };
  mockHosted = undefined;
  Object.values(mockBroker).forEach((value) => value.mockClear());
});

describe('owner-only agent computer takeover route', () => {
  test('only the owner of an opted-in native installation can see a frame', async () => {
    const frame = await request(app).get(`/api/agent-computer/${mockInstallation}/frame`);
    expect(frame.status).toBe(200);
    expect(frame.headers['content-type']).toMatch(/image\/png/);
    expect(frame.headers['cache-control']).toBe('no-store');
    mockViewer = mockOther;
    expect((await request(app).get(`/api/agent-computer/${mockInstallation}/frame`)).status).toBe(403);
    expect(mockBroker.humanScreenshot).toHaveBeenCalledTimes(1);
    mockViewer = mockOwner;
    mockDeclared = false;
    expect((await request(app).get(`/api/agent-computer/${mockInstallation}/frame`)).status).toBe(403);
  });

  // A non-admin owner can only run a computer agent as a hosted install on the native engine
  // ('native' itself is entitlement-gated at install). Those turns run in this process and get the
  // computer tools, so the takeover bridge must accept the same set, and only that set.
  test('a hosted install on the native engine gets the takeover; other engines and runtimes do not', async () => {
    mockRuntime = { runtimeType: 'hosted' };
    mockHosted = { engine: 'native' };
    expect((await request(app).get(`/api/agent-computer/${mockInstallation}/status`)).status).toBe(200);
    // Marked native by the migration but not recorded done: its Durable Object may still run.
    mockHosted = { engine: 'native', migratedFrom: 'durable-object', migration: { state: 'pending' } };
    expect((await request(app).get(`/api/agent-computer/${mockInstallation}/status`)).status).toBe(403);
    mockHosted = { engine: 'durable-object' };
    const otherEngine = await request(app).get(`/api/agent-computer/${mockInstallation}/status`);
    expect(otherEngine.status).toBe(403);
    expect(otherEngine.body.code).toBe('computer_not_granted');
    mockHosted = undefined;
    expect((await request(app).get(`/api/agent-computer/${mockInstallation}/status`)).status).toBe(403);
    mockRuntime = { runtimeType: 'webhook' };
    mockHosted = { engine: 'native' };
    expect((await request(app).get(`/api/agent-computer/${mockInstallation}/status`)).status).toBe(403);
    expect(mockBroker.takeoverStatus).toHaveBeenCalledTimes(1);
  });

  test('human input is forwarded without echoing credential text', async () => {
    const typed = await request(app).post(`/api/agent-computer/${mockInstallation}/type`)
      .send({ text: 'human-only-password', frameRevision: 'rev-1' });
    expect(typed.status).toBe(200);
    expect(typed.text).not.toContain('human-only-password');
    expect(mockBroker.humanType).toHaveBeenCalledWith(mockOwner, mockInstallation, 'human-only-password', 'rev-1');
    const returned = await request(app).post(`/api/agent-computer/${mockInstallation}/hand-back`).send({});
    expect(returned.status).toBe(200);
    expect(mockBroker.handBack).toHaveBeenCalledWith(mockOwner, mockInstallation);
  });

  test('disabled flag yields no takeover surface', async () => {
    mockEnabled = false;
    expect((await request(app).get(`/api/agent-computer/${mockInstallation}/status`)).status).toBe(404);
    expect(mockBroker.takeoverStatus).not.toHaveBeenCalled();
  });

  test('a stale frame returns a distinct 409 for the viewer to refresh', async () => {
    mockBroker.humanClick.mockRejectedValueOnce(new Error('Stale computer frame. Refresh before acting.'));
    const response = await request(app).post(`/api/agent-computer/${mockInstallation}/click`)
      .send({ x: 10, y: 10, frameRevision: 'old' });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('stale_frame');
  });

  test('a computer connection failure never exposes its endpoint or diagnostic log', async () => {
    const endpoint = 'ws://127.0.0.1:9223/PRIVATE-CDP-ENDPOINT-SENTINEL';
    mockBroker.takeoverStatus.mockRejectedValueOnce(new Error(
      `browserType.connectOverCDP: WebSocket error: ${endpoint}\nCall log:\n  - connecting to ${endpoint}`,
    ));
    const response = await request(app).get(`/api/agent-computer/${mockInstallation}/status`);
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ code: 'computer_unavailable', error: 'Agent computer is unavailable.' });
    expect(response.text).not.toContain(endpoint);

    mockBroker.humanClick.mockRejectedValueOnce(new Error(`Stale computer frame. ${endpoint}`));
    const prefixed = await request(app).post(`/api/agent-computer/${mockInstallation}/click`)
      .send({ x: 10, y: 10, frameRevision: 'old' });
    expect(prefixed.body).toEqual({ code: 'computer_unavailable', error: 'Agent computer is unavailable.' });
    expect(prefixed.text).not.toContain(endpoint);
  });

  test('takeover and pending-write conflicts retain stable public codes', async () => {
    mockBroker.humanScreenshot.mockRejectedValueOnce(new Error('No human takeover is active.'));
    const takeover = await request(app).get(`/api/agent-computer/${mockInstallation}/frame`);
    expect(takeover.body).toEqual({ code: 'takeover_not_active', error: 'No human takeover is active.' });

    mockBroker.decideWrite.mockRejectedValueOnce(new Error('Pending write is unavailable.'));
    const pending = await request(app).post(`/api/agent-computer/${mockInstallation}/decide-write`)
      .send({ requestId: '11111111-1111-4111-8111-111111111111', approve: true });
    expect(pending.body).toEqual({ code: 'pending_write_unavailable', error: 'Pending write is unavailable.' });
  });

  test('the owner alone can decide an intercepted write without exposing its body', async () => {
    const requestId = '11111111-1111-4111-8111-111111111111';
    const response = await request(app).post(`/api/agent-computer/${mockInstallation}/decide-write`)
      .send({ requestId, approve: true });
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(mockBroker.decideWrite).toHaveBeenCalledWith(mockOwner, mockInstallation, requestId, true);
    mockViewer = mockOther;
    expect((await request(app).post(`/api/agent-computer/${mockInstallation}/decide-write`)
      .send({ requestId, approve: true })).status).toBe(403);
    expect(mockBroker.decideWrite).toHaveBeenCalledTimes(1);
  });
});
