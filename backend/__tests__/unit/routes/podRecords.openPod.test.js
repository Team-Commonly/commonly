/**
 * F265 at the route: every way out of the record for a member of a pod anyone
 * can join. Real route and service; the store, pod and task are stand-ins, and
 * the lines are real hash-chained lines.
 */
const express = require('express');
const request = require('supertest');
const { appendEntry, hashLine, verifyRecord } = require('../../../vendor/seats/src/record/format');

const POD = 'aaaaaaaaaaaaaaaaaaaaaa01';
const OWNER = 'bbbbbbbbbbbbbbbbbbbbbb01'; // approves, and owns the credential
const JOINER = 'bbbbbbbbbbbbbbbbbbbbbb02';
const AGENT = 'cccccccccccccccccccccc01';
const ADMIN = 'dddddddddddddddddddddd01';
const CREATOR = 'bbbbbbbbbbbbbbbbbbbbbb03';
const OPEN = { _id: POD, type: 'team', publicRead: true, communityListed: true, joinPolicy: 'open', createdBy: CREATOR, members: [OWNER, JOINER, AGENT, CREATOR] };

const mockChain = { pod: null, lines: [], unconfirmedTask: false };
const mockCanView = jest.fn(async () => true);

jest.mock('../../../repositories/recordChainRepository', () => {
  const actual = jest.requireActual('../../../repositories/recordChainRepository');
  return {
    ...actual,
    readChain: async (_ref, _db, page = {}) => {
      if (mockChain.lines.length === 0) return null;
      const after = page.after || 0;
      const limit = Math.min(actual.MAX_PAGE_LINES, page.limit || actual.MAX_PAGE_LINES);
      const lines = mockChain.lines.slice(after, after + limit);
      const last = after + lines.length;
      const { hashLine: hash } = jest.requireActual('../../../vendor/seats/src/record/format');
      return {
        runId: 'srv-pod-0123456789', headSeq: mockChain.lines.length, headHash: hash(mockChain.lines.at(-1)),
        lines, openings: [], nextAfter: last < mockChain.lines.length ? last : null,
      };
    },
  };
});
jest.mock('../../../services/recordService', () => ({
  ...jest.requireActual('../../../services/recordService'),
  isRecordEnabled: () => true,
}));
jest.mock('../../../middleware/dualAuth', () => (req, res, next) => {
  if (req.get('x-agent')) req.agentUser = { _id: req.get('x-agent') };
  else req.userId = req.get('x-user');
  next();
});
jest.mock('../../../models/Pod', () => ({
  findById: () => ({ select: () => ({ lean: async () => mockChain.pod }) }),
}));
jest.mock('../../../models/Task', () => ({ findOne: () => ({ select: () => ({ lean: async () => ({ _id: 'task' }) }) }) }));
jest.mock('../../../services/dmService', () => ({ canViewPod: (...args) => mockCanView(...args) }));
jest.mock('../../../middleware/ipRateLimit', () => ({ cloudflareIpRateLimitKeyGenerator: () => 'test' }));

const app = express();
app.use('/api/pods', require('../../../routes/podRecords'));

const salt = (n) => String(n).padStart(32, '0');
const build = ({ salted = true } = {}) => {
  const lines = [];
  const add = (kind, data, actor) => lines.push(appendEntry(lines.at(-1) ?? null, {
    runId: 'srv-pod-0123456789', podId: POD, ts: `2026-11-06T12:00:0${lines.length}.000Z`, kind, data,
    ...(actor ? { actor } : {}), ...(salted ? { salt: salt(lines.length + 1) } : {}),
  }));
  add('permission.requested', { question: 'sentry.write', askedOf: { id: OWNER, role: 'credential-owner' }, toolCallId: 'tc' }, { type: 'agent', id: AGENT });
  add('permission.decided', { outcome: 'selected', toolCallId: 'tc', rule: { list: 'ask', pattern: null }, decidedBy: OWNER, decidedByRole: 'credential-owner' });
  add('tool.update', { toolCallId: 'tc', status: 'completed' }, { type: 'agent', id: AGENT });
  return lines;
};
const read = (path, who = { 'x-user': JOINER }) => request(app).get(`/api/pods/${POD}/record${path}`).set(who);

beforeEach(() => {
  jest.clearAllMocks();
  mockChain.pod = OPEN;
  mockChain.lines = build();
  mockCanView.mockResolvedValue(true);
});

describe.each([['the pod chain', ''], ['a task chain', '/tasks/TASK-7']])('%s on an open pod', (_name, suffix) => {
  test('a member who is not named reads no owner id, and their check passes on what they got', async () => {
    const res = await read(suffix);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(OWNER);
    expect(res.headers['x-record-view']).toBe('redacted');
    expect(res.headers['x-record-redacted']).toBe('2');
    expect(res.headers['x-record-unlinked']).toBe('0');
    const result = verifyRecord(res.text);
    expect(result).toMatchObject({ ok: true, partial: true, redacted: [1, 2], unlinked: [] });
    expect(res.headers['x-record-head']).toBe(result.head);
  });

  test('the person named reads their own id', async () => {
    const res = await read(suffix, { 'x-user': OWNER });
    expect(res.text).toContain(OWNER);
    expect(verifyRecord(res.text).ok).toBe(true);
  });

  test('an agent reader is held to the same view', async () => {
    const res = await read(suffix, { 'x-agent': AGENT });
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(OWNER);
    expect(res.headers['x-record-view']).toBe('redacted');
  });

  test('?format=otlp carries no owner id, with or without a cursor', async () => {
    const whole = await read(`${suffix}?format=otlp`);
    expect(whole.status).toBe(200);
    expect(JSON.stringify(whole.body)).not.toContain(OWNER);
    expect(JSON.stringify(whole.body)).toContain('permission.decided');
    const paged = await read(`${suffix}?format=otlp&after=1&limit=1`);
    expect(JSON.stringify(paged.body)).not.toContain(OWNER);
  });

  test('a page does not leak what the whole view hides, and pages join into one passing view', async () => {
    const first = await read(`${suffix}?limit=1`);
    const second = await read(`${suffix}?after=${first.headers['x-record-next-after']}`);
    expect(first.text + second.text).not.toContain(OWNER);
    expect(verifyRecord(first.text + second.text)).toMatchObject({ ok: true, entries: 3 });
  });
});

describe('a chain longer than one page on an open pod', () => {
  test('?format=otlp with no cursor exports every line of the view, not its first page', async () => {
    const lines = build();
    for (let n = lines.length; n < 1002; n += 1) {
      lines.push(appendEntry(lines.at(-1), {
        runId: 'srv-pod-0123456789', podId: POD, ts: '2026-11-06T12:01:00.000Z', kind: 'tool.update', actor: { type: 'agent', id: AGENT },
        data: { toolCallId: `tc-${n}` }, salt: salt(n + 1),
      }));
    }
    mockChain.lines = lines;
    const res = await read('?format=otlp');
    const events = res.body.resourceSpans[0].scopeSpans[0].spans.flatMap((span) => span.events);
    expect(events).toHaveLength(1002);
    expect(res.headers['x-record-next-after']).toBeUndefined();
  });
});

describe('legacy lines on an open pod', () => {
  test('nothing that covers a guessable line goes out, the head header included', async () => {
    mockChain.lines = build({ salted: false });
    const res = await read('');
    expect(res.headers['x-record-head']).toBeUndefined();
    mockChain.lines.forEach((line) => expect(res.text).not.toContain(hashLine(line)));
    expect(res.headers['x-record-unlinked']).toBe('3');
    expect(verifyRecord(res.text)).toMatchObject({ ok: true, partial: true, unlinked: [1, 2, 3] });
  });
});

describe('pods that keep the full record', () => {
  test.each([
    ['invite-only', { ...OPEN, joinPolicy: 'invite-only' }],
    ['unlisted with the default joinPolicy', { ...OPEN, communityListed: false, publicRead: false }],
    ['an agent room', { ...OPEN, type: 'agent-room' }],
  ])('%s: a member reads the stored bytes and the head', async (_name, pod) => {
    mockChain.pod = pod;
    const res = await read('');
    expect(res.text).toBe(mockChain.lines.map((line) => `${line}\n`).join(''));
    expect(res.headers['x-record-head']).toBe(hashLine(mockChain.lines.at(-1)));
    expect(res.headers['x-record-view']).toBeUndefined();
  });
});

describe('the pod\'s creator on an open pod', () => {
  test('reads what a member of a private pod reads: stored bytes, head and a whole check', async () => {
    const res = await read('', { 'x-user': CREATOR });
    expect(res.text).toBe(mockChain.lines.map((line) => `${line}\n`).join(''));
    expect(res.headers['x-record-view']).toBeUndefined();
    expect(res.headers['x-record-head']).toBe(hashLine(mockChain.lines.at(-1)));
    const result = verifyRecord(res.text);
    expect(result.ok).toBe(true);
    expect(result.partial).toBeUndefined();
  });
  test('older unsalted lines too: nothing is held back from them', async () => {
    mockChain.lines = build({ salted: false });
    const res = await read('', { 'x-user': CREATOR });
    expect(res.text).toContain(OWNER);
    expect(verifyRecord(res.text).partial).toBeUndefined();
  });
  test('an admin who is not the creator gets nothing extra, as a member or otherwise', async () => {
    expect((await read('', { 'x-user': ADMIN })).status).toBe(403);
  });
});

describe('who reads at all stays as it was', () => {
  test('an admin who is not a member, or an agent-DM observer, is refused on an open pod', async () => {
    expect((await read('', { 'x-user': ADMIN })).status).toBe(403);
  });
  test('someone who cannot view the pod gets a 404', async () => {
    mockCanView.mockResolvedValue(false);
    expect((await read('', { 'x-user': ADMIN })).status).toBe(404);
  });
});
