/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
jest.mock('../../../services/recordService', () => {
  const actual = jest.requireActual('../../../services/recordService');
  return { ...actual, emitRecord: jest.fn() };
});
const { emitRecord } = require('../../../services/recordService');
const { taskTransitionLine, recordTaskTransition } = require('../../../services/taskRecordService');

const AGENT = { type: 'agent', id: '6a920d43b08dee6c42a81c9e' };
const AT = new Date('2026-10-26T05:00:00.000Z');
const LEASE = new Date('2026-10-26T05:30:00.000Z');
const line = (over) => taskTransitionLine({ podId: 'p', task: { taskId: 'TASK-1' }, at: AT, actor: AGENT, ...over });

describe('board transitions → record lines (record-v1 §2, Claim)', () => {
  it.each([
    ['a fresh claim', { from: 'pending', to: 'claimed', task: { claimExpiresAt: LEASE } },
      { kind: 'task.claimed', actor: AGENT, data: { leaseUntil: LEASE.toISOString() } }],
    ['resuming a blocked task', { from: 'blocked', to: 'claimed' }, { kind: 'task.claimed', actor: AGENT, data: {} }],
    ['a takeover of a lapsed claim', { from: 'claimed', to: 'claimed', renewal: false }, { kind: 'task.claimed', actor: AGENT, data: {} }],
    ['completion', { from: 'claimed', to: 'done', doneBy: 'u1' }, { kind: 'task.done', actor: { type: 'system', id: 'board' }, data: { doneBy: 'u1' } }],
    ['completion by the system', { from: null, to: 'done' }, { kind: 'task.done', actor: { type: 'system', id: 'board' }, data: {} }],
    ['blocking a claimed task', { from: 'claimed', to: 'blocked' }, { kind: 'task.released', actor: AGENT, data: { reason: 'blocked' } }],
    ['a lapsed lease', { from: 'claimed', to: 'pending', reason: 'lease_expired' }, { kind: 'task.released', actor: AGENT, data: { reason: 'lease_expired' } }],
    ['returning a claim to pending', { from: 'claimed', to: 'pending' }, { kind: 'task.released', actor: AGENT, data: {} }],
  ])('%s', (_label, change, expected) => {
    expect(line(change)).toEqual(expected);
  });

  it.each([
    ['a renewal by the holder', { from: 'claimed', to: 'claimed', renewal: true }],
    ['a PATCH that leaves a claim claimed', { from: 'claimed', to: 'claimed' }],
    ['marking a done task done', { from: 'done', to: 'done' }],
    ['unblocking to pending', { from: 'blocked', to: 'pending' }],
    ['reopening', { from: 'done', to: 'pending' }],
    ['blocking an unclaimed task', { from: 'pending', to: 'blocked' }],
  ])('writes nothing for %s', (_label, change) => {
    expect(line(change)).toBeNull();
  });

  it('keys each committed write, so a redelivery is one line', () => {
    recordTaskTransition({ podId: 'p', task: { _id: 'oid', taskId: 'TASK-1' }, from: 'pending', to: 'claimed', at: AT, actor: AGENT });
    expect(emitRecord).toHaveBeenCalledWith({ podId: 'p', taskId: 'TASK-1' }, `task.claimed/oid/${AT.toISOString()}`, [expect.objectContaining({ kind: 'task.claimed' })]);
  });

  it('needs a pod and a task id', () => {
    emitRecord.mockClear();
    recordTaskTransition({ podId: '', task: { taskId: 'TASK-1' }, from: 'pending', to: 'claimed', at: AT });
    recordTaskTransition({ podId: 'p', task: {}, from: 'pending', to: 'claimed', at: AT });
    expect(emitRecord).not.toHaveBeenCalled();
  });
});
