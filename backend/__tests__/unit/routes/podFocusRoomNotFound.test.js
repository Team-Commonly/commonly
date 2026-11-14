// F497: GET and PATCH /api/pods/:id/focus answer a non-member of an
// agent-room or agent-admin with 404, as those types' rules say (CLAUDE.md),
// so a refusal doesn't confirm the room exists. Other pod types, and a member
// refused for another reason, keep their 403.
const express = require('express');
const request = require('supertest');

jest.mock('jsonwebtoken', () => ({ sign: jest.fn(() => 't'), verify: jest.fn(), decode: jest.fn() }));
jest.mock('../../../middleware/auth', () => (req, _res, next) => {
  req.user = { id: '6a0000000000000000000001' };
  req.userId = '6a0000000000000000000001';
  next();
});
jest.mock('../../../middleware/adminAuth', () => (_req, _res, next) => next());
jest.mock('../../../services/dmService', () => ({ canViewPod: jest.fn(async () => true) }));
const mockPodRow = { value: null, error: null };
jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(() => ({
    select: () => ({ lean: async () => { if (mockPodRow.error) throw mockPodRow.error; return mockPodRow.value; } }),
  })),
}));
jest.mock('../../../services/podFocusService', () => ({
  read: jest.fn(),
  permissions: jest.fn(),
  update: jest.fn(),
}));

const PodFocusService = require('../../../services/podFocusService');

const app = express();
app.use(express.json());
app.use('/api/pods', require('../../../routes/pods'));

const POD = '6a0000000000000000000002';
const USER = '6a0000000000000000000001';
const forbidden = () => Object.assign(new Error('Only the pod creator or a global admin may edit pod focus'), {
  status: 403, code: 'FOCUS_EDIT_FORBIDDEN',
});
const notFound = () => Object.assign(new Error('Pod not found'), { status: 404, code: 'POD_NOT_FOUND' });
const patch = () => request(app).patch(`/api/pods/${POD}/focus`).send({ expectedRevision: 0, focus: null });
const notMember = () => Object.assign(new Error('Not authorized for this pod'), { status: 403, code: 'NOT_A_MEMBER' });

beforeEach(() => {
  jest.clearAllMocks();
  mockPodRow.error = null;
  PodFocusService.read.mockRejectedValue(notMember());
  PodFocusService.update.mockRejectedValue(forbidden());
});

test.each([['agent-room'], ['agent-admin']])('a non-member of a %s gets 404', async (type) => {
  mockPodRow.value = { _id: POD, type };
  const res = await request(app).get(`/api/pods/${POD}/focus`);
  expect(res.status).toBe(404);
  expect(res.body).toEqual({ message: 'Pod not found', code: 'POD_NOT_FOUND' });
});

test.each([['chat'], ['agent-dm']])('a non-member of a %s still gets 403', async (type) => {
  mockPodRow.value = { _id: POD, type };
  const res = await request(app).get(`/api/pods/${POD}/focus`);
  expect(res.status).toBe(403);
  expect(res.body.code).toBe('NOT_A_MEMBER');
});

test('a member still reads the focus', async () => {
  const read = { podId: POD, revision: 0, focus: null };
  PodFocusService.read.mockResolvedValue(read);
  PodFocusService.permissions.mockResolvedValue({ canEdit: false });
  const res = await request(app).get(`/api/pods/${POD}/focus`);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ ...read, permissions: { canEdit: false } });
});

test('the 404 a stranger to a room gets is the same answer a missing pod gives', async () => {
  mockPodRow.value = { _id: POD, type: 'agent-room', members: [] };
  const room = await request(app).get(`/api/pods/${POD}/focus`);
  PodFocusService.read.mockRejectedValue(notFound());
  const missing = await request(app).get(`/api/pods/${POD}/focus`);
  expect([room.status, room.body]).toEqual([missing.status, missing.body]);
});

test.each([
  ['the lookup fails', () => { mockPodRow.error = new Error('db down'); }],
  ['the pod row is gone', () => { mockPodRow.value = null; }],
])('when %s, the refusal stays 403', async (_label, arrange) => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  arrange();
  const res = await request(app).get(`/api/pods/${POD}/focus`);
  expect(res.status).toBe(403);
  expect(res.body.code).toBe('NOT_A_MEMBER');
  warn.mockRestore();
});

describe('PATCH', () => {
  test.each([['agent-room'], ['agent-admin']])('a stranger to a %s gets 404', async (type) => {
    mockPodRow.value = { _id: POD, type, members: [] };
    const res = await patch();
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: 'Pod not found', code: 'POD_NOT_FOUND' });
  });

  test('a member of the room who is not its creator still gets 403', async () => {
    mockPodRow.value = { _id: POD, type: 'agent-room', members: [USER] };
    const res = await patch();
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FOCUS_EDIT_FORBIDDEN');
  });

  test('a non-creator of a chat pod still gets 403', async () => {
    mockPodRow.value = { _id: POD, type: 'chat', members: [] };
    const res = await patch();
    expect(res.status).toBe(403);
  });
});
