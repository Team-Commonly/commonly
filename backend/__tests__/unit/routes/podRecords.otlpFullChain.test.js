/**
 * The record route pages the NDJSON read, but ?format=otlp has no paging of
 * its own. An OTLP read with no cursor must cover the whole chain, not the
 * first page, or a long chain exports a silently short trace.
 */
const express = require('express');
const request = require('supertest');

const POD = 'aaaaaaaaaaaaaaaaaaaaaa01';
const USER = 'bbbbbbbbbbbbbbbbbbbbbbb1';

const mockReadRecordExport = jest.fn();
const mockToOtlp = jest.fn(() => ({ resourceSpans: [] }));

jest.mock('../../../services/recordService', () => ({
  isRecordEnabled: () => true,
  isRecordReader: (members, userId) => (members || []).some((m) => String(m) === String(userId)),
  readRecordExport: (...args) => mockReadRecordExport(...args),
  toOtlp: (...args) => mockToOtlp(...args),
  RecordStoreUnavailableError: class RecordStoreUnavailableError extends Error {},
}));
jest.mock('../../../middleware/dualAuth', () => (req, res, next) => {
  req.userId = USER;
  next();
});
jest.mock('../../../models/Pod', () => ({
  findById: () => ({ select: () => ({ lean: async () => ({ _id: POD, type: 'chat', members: [USER] }) }) }),
}));
jest.mock('../../../models/Task', () => ({ findOne: jest.fn() }));
jest.mock('../../../services/dmService', () => ({ canViewPod: async () => true }));
jest.mock('../../../middleware/ipRateLimit', () => ({
  cloudflareIpRateLimitKeyGenerator: () => 'test',
}));

const router = require('../../../routes/podRecords');

const app = express();
app.use('/api/pods', router);

// Three pages of one line each, as readRecordExport returns them.
const pages = {
  start: { jsonl: '{"seq":1}\n', nextAfter: 1 },
  1: { jsonl: '{"seq":2}\n', nextAfter: 2 },
  2: { jsonl: '{"seq":3}\n', nextAfter: null },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockReadRecordExport.mockImplementation(async (_ref, _db, page = {}) => (
    page.after === undefined ? pages.start : pages[page.after]
  ));
});

describe('GET /api/pods/:podId/record?format=otlp', () => {
  test('an OTLP read with no cursor exports every page of the chain', async () => {
    const res = await request(app).get(`/api/pods/${POD}/record?format=otlp`);
    expect(res.status).toBe(200);
    expect(mockToOtlp).toHaveBeenCalledWith('{"seq":1}\n{"seq":2}\n{"seq":3}\n');
  });

  test('a paged NDJSON read still returns one page with its cursor', async () => {
    const res = await request(app).get(`/api/pods/${POD}/record`);
    expect(res.status).toBe(200);
    expect(res.text).toBe('{"seq":1}\n');
    expect(res.headers['x-record-next-after']).toBe('1');
    expect(mockReadRecordExport).toHaveBeenCalledTimes(1);
  });

  test('an OTLP read with an explicit cursor stays one page', async () => {
    await request(app).get(`/api/pods/${POD}/record?format=otlp&after=1`);
    expect(mockToOtlp).toHaveBeenCalledWith('{"seq":2}\n');
  });
});
