/**
 * GET /api/approvals/pending — the durable pending-approvals index (ADR-020).
 * Backed by ApprovalAction rows, not card messages: messages retire under
 * the 30-day retention window; flagged approvals must stay findable.
 * Read gate = pod visibility; deciding stays owner-only in /resolve.
 */
const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.userId = 'u1';
  req.user = { id: 'u1', _id: 'u1' };
  next();
});

const mockPodFindById = jest.fn();
jest.mock('../../../models/Pod', () => ({
  findById: (...args) => mockPodFindById(...args),
}));

const mockCanViewPod = jest.fn();
jest.mock('../../../services/dmService', () => ({
  canViewPod: (...args) => mockCanViewPod(...args),
}));

const mockApprovalFind = jest.fn();
jest.mock('../../../models/ApprovalAction', () => ({
  find: (...args) => mockApprovalFind(...args),
}));

jest.mock('../../../services/approvalActionService', () => ({
  buildCardPayload: (row) => ({
    kind: 'approval-card',
    approvalId: String(row._id),
    summary: row.summary,
    agentName: row.agentName,
    ownerUserId: String(row.ownerUserId),
    status: row.status,
  }),
  resolveApproval: jest.fn(),
}));

const approvalsRouter = require('../../../routes/approvals');

const app = express();
app.use(express.json());
app.use('/api/approvals', approvalsRouter);

const POD_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

beforeEach(() => {
  jest.clearAllMocks();
  mockPodFindById.mockResolvedValue({ _id: POD_ID, members: ['u1'] });
  mockCanViewPod.mockResolvedValue(true);
  mockApprovalFind.mockReturnValue({
    sort: jest.fn().mockReturnValue({
      limit: jest.fn().mockResolvedValue([
        {
          _id: 'appr-1',
          summary: 'Create a pod called Design Studio',
          agentName: 'guide',
          ownerUserId: 'u1',
          status: 'flagged',
          messageId: '123',
          createdAt: new Date('2026-08-13T07:00:00Z'),
        },
      ]),
    }),
  });
});

describe('GET /api/approvals/pending', () => {
  test('returns flagged rows with card payloads for a pod member', async () => {
    const res = await request(app).get(`/api/approvals/pending?podId=${POD_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.approvals).toHaveLength(1);
    expect(res.body.approvals[0]).toEqual(expect.objectContaining({
      approvalId: 'appr-1',
      agentName: 'guide',
      messageId: '123',
    }));
    expect(mockApprovalFind).toHaveBeenCalledWith({ podId: POD_ID, status: 'flagged' });
  });

  test('403s a caller who cannot view the pod', async () => {
    mockCanViewPod.mockResolvedValue(false);
    const res = await request(app).get(`/api/approvals/pending?podId=${POD_ID}`);
    expect(res.status).toBe(403);
    expect(mockApprovalFind).not.toHaveBeenCalled();
  });

  test('400s a missing or malformed podId', async () => {
    const res = await request(app).get('/api/approvals/pending?podId=nope');
    expect(res.status).toBe(400);
  });
});
