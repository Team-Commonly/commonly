// F124 (TASK-766): GET/PATCH /api/pods/:id/conventions. The service holds the
// rules (unit-tested beside it); this checks what the route adds: the body
// shape, permissions on a read, and the current text on a conflict.
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
jest.mock('../../../services/podConventionsService', () => ({
  read: jest.fn(),
  update: jest.fn(),
  permissions: jest.fn(),
}));

const PodConventionsService = require('../../../services/podConventionsService');
const DMService = require('../../../services/dmService');

const app = express();
app.use(express.json());
app.use('/api/pods', require('../../../routes/pods'));

const POD = '6a0000000000000000000002';
const USER = '6a0000000000000000000001';
const read = { podId: POD, revision: 1, conventions: { text: 'Reply in a thread.', updatedAt: '2026-11-14T00:00:00.000Z', updatedBy: { userId: USER, label: 'alice' } } };

beforeEach(() => {
  jest.clearAllMocks();
  DMService.canViewPod.mockResolvedValue(true);
  mockPodRow.value = { _id: POD, type: 'chat', members: [USER] };
});

// CodeRabbit on #4112: every new pod-scoped read calls DMService.canViewPod
// before returning content. The service's own member check still runs after.
test('GET runs the shared visibility check first, and a refusal returns no conventions', async () => {
  DMService.canViewPod.mockResolvedValue(false);
  const res = await request(app).get(`/api/pods/${POD}/conventions`);
  expect(res.status).toBe(403);
  expect(res.body.conventions).toBeUndefined();
  expect(DMService.canViewPod).toHaveBeenCalledWith(USER, mockPodRow.value);
  expect(PodConventionsService.read).not.toHaveBeenCalled();
});

test.each([['agent-room'], ['agent-admin']])('GET on a %s the caller may not see answers 404', async (type) => {
  mockPodRow.value = { _id: POD, type, members: [] };
  DMService.canViewPod.mockResolvedValue(false);
  const res = await request(app).get(`/api/pods/${POD}/conventions`);
  expect(res.status).toBe(404);
  expect(PodConventionsService.read).not.toHaveBeenCalled();
});

test('GET on a missing pod answers 404', async () => {
  mockPodRow.value = null;
  const res = await request(app).get(`/api/pods/${POD}/conventions`);
  expect(res.status).toBe(404);
});

test('GET returns the read and whether the caller may edit', async () => {
  PodConventionsService.read.mockResolvedValue(read);
  PodConventionsService.permissions.mockResolvedValue({ canEdit: false });
  const res = await request(app).get(`/api/pods/${POD}/conventions`);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ ...read, permissions: { canEdit: false } });
  expect(PodConventionsService.read).toHaveBeenCalledWith({ podId: POD, userId: USER });
});

test('GET passes the service refusal through', async () => {
  PodConventionsService.read.mockRejectedValue(Object.assign(new Error('Not authorized for this pod'), { status: 403, code: 'NOT_A_MEMBER' }));
  const res = await request(app).get(`/api/pods/${POD}/conventions`);
  expect(res.status).toBe(403);
  expect(res.body.code).toBe('NOT_A_MEMBER');
});

test.each([
  [{ text: 'x' }],
  [{ expectedRevision: 0 }],
  [{ expectedRevision: 0, text: 'x', extra: true }],
])('PATCH refuses a body that is not exactly expectedRevision and text: %j', async (body) => {
  const res = await request(app).patch(`/api/pods/${POD}/conventions`).send(body);
  expect(res.status).toBe(400);
  expect(res.body.code).toBe('INVALID_CONVENTIONS_REQUEST');
  expect(PodConventionsService.update).not.toHaveBeenCalled();
});

test('PATCH refuses a revision that is not an integer', async () => {
  const res = await request(app).patch(`/api/pods/${POD}/conventions`).send({ expectedRevision: '0', text: 'x' });
  expect(res.status).toBe(400);
  expect(res.body.code).toBe('INVALID_REVISION');
});

test('PATCH saves and answers with the new read', async () => {
  PodConventionsService.update.mockResolvedValue(read);
  const res = await request(app).patch(`/api/pods/${POD}/conventions`).send({ expectedRevision: 0, text: 'Reply in a thread.' });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ ...read, permissions: { canEdit: true } });
  expect(PodConventionsService.update).toHaveBeenCalledWith({ podId: POD, userId: USER, expectedRevision: 0, text: 'Reply in a thread.' });
});

test('PATCH on a conflict answers 409 with the current text', async () => {
  PodConventionsService.update.mockRejectedValue(Object.assign(new Error('Conventions changed while you were editing'), {
    status: 409, code: 'CONVENTIONS_CONFLICT', fields: { expectedRevision: '0', currentRevision: '1' },
  }));
  PodConventionsService.read.mockResolvedValue(read);
  const res = await request(app).patch(`/api/pods/${POD}/conventions`).send({ expectedRevision: 0, text: 'x' });
  expect(res.status).toBe(409);
  expect(res.body).toMatchObject({ code: 'CONVENTIONS_CONFLICT', fields: { currentRevision: '1' }, current: read });
});
