// F497: GET /api/pods/:id/focus answers a non-member of an agent-room or
// agent-admin with 404, as those types' rules say (CLAUDE.md), so the refusal
// doesn't confirm the room exists. Other pod types keep their 403.
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
const mockPodRow = { value: null };
jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(() => ({ select: () => ({ lean: async () => mockPodRow.value }) })),
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
const notMember = () => Object.assign(new Error('Not authorized for this pod'), { status: 403, code: 'NOT_A_MEMBER' });

beforeEach(() => {
  jest.clearAllMocks();
  PodFocusService.read.mockRejectedValue(notMember());
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
