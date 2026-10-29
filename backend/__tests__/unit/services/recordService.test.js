/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
// An in-memory chain store with the repository's contract: build() runs with
// the previous line, and a seen event key appends nothing.
const mockChains = new Map();
jest.mock('../../../repositories/recordChainRepository', () => {
  const actual = jest.requireActual('../../../repositories/recordChainRepository');
  const key = (ref) => `${ref.podId}|${ref.taskId || ''}`;
  return {
    ...actual,
    appendToChain: jest.fn(async (ref, runId, eventKey, build) => {
      if (!mockChains.has(key(ref))) mockChains.set(key(ref), { runId, lines: [], keys: new Set(), head: null });
      const chain = mockChains.get(key(ref));
      if (chain.keys.has(eventKey)) return { appended: 0, duplicate: true };
      const { lines, headHash } = build(chain.lines[chain.lines.length - 1] || null, chain.runId);
      chain.lines.push(...lines);
      chain.keys.add(eventKey);
      chain.head = headHash;
      return { appended: lines.length, duplicate: false };
    }),
    readChain: jest.fn(async (ref) => {
      const chain = mockChains.get(key(ref));
      return chain ? { runId: chain.runId, headSeq: chain.lines.length, headHash: chain.head, lines: [...chain.lines] } : null;
    }),
  };
});

const repository = require('../../../repositories/recordChainRepository');
const record = require('../../../services/recordService');
const { verifyRecord, hashLine } = require('../../../vendor/seats/src/record/format');

const POD = '6a692a1be833c668acdb84cf';
const AGENT = { _id: '6a920d43b08dee6c42a81c9e', isBot: true, botMetadata: { ownerUserId: '6a47891ee025ce2e0ca1d30b' } };

describe('recordService', () => {
  const env = process.env.RECORD_V1_PODS;
  beforeEach(() => {
    mockChains.clear();
    process.env.RECORD_V1_PODS = POD;
  });
  afterAll(() => {
    if (env === undefined) delete process.env.RECORD_V1_PODS;
    else process.env.RECORD_V1_PODS = env;
  });

  it('writes a chain that verifies under the shared reference verifier, and matches the stored head', async () => {
    const ref = { podId: POD, taskId: 'TASK-1' };
    await record.appendRecord(ref, 'e1', [{ kind: 'task.claimed', actor: record.agentActor(AGENT) }]);
    await record.appendRecord(ref, 'e2', [{ kind: 'task.done', actor: record.BOARD_ACTOR, data: { doneBy: AGENT._id } }]);
    const out = await record.readRecordExport(ref);
    const result = verifyRecord(out.jsonl);
    expect(result).toMatchObject({ ok: true, entries: 2, settled: false });
    expect(out.head).toBe(result.head);
    const lines = out.jsonl.trimEnd().split('\n').map((line) => JSON.parse(line));
    expect(lines.map((l) => [l.seq, l.kind, l.podId, l.taskId, l.runId])).toEqual([
      [1, 'task.claimed', POD, 'TASK-1', record.serverRunId(ref)],
      [2, 'task.done', POD, 'TASK-1', record.serverRunId(ref)],
    ]);
    expect(lines[0].actor).toEqual({ type: 'agent', id: AGENT._id, owner: AGENT.botMetadata.ownerUserId });
    expect(lines[1].actor).toEqual({ type: 'system', id: 'board' });
    expect(lines[1].prev).toBe(hashLine(out.jsonl.split('\n')[0]));
  });

  it('a redelivered event key appends nothing', async () => {
    const ref = { podId: POD, taskId: 'TASK-2' };
    expect(await record.appendRecord(ref, 'same', [{ kind: 'task.claimed', actor: null }])).toEqual({ appended: 1, duplicate: false });
    expect(await record.appendRecord(ref, 'same', [{ kind: 'task.claimed', actor: null }])).toEqual({ appended: 0, duplicate: true });
    expect((await record.readRecordExport(ref)).entries).toBe(1);
  });

  it('refuses a malformed line before anything is stored', async () => {
    const ref = { podId: POD, taskId: 'TASK-3' };
    await expect(record.appendRecord(ref, 'bad', [
      { kind: 'task.claimed', actor: null },
      { kind: 'task.done', actor: record.BOARD_ACTOR, data: { doneBy: 'a display name' } },
    ])).rejects.toThrow(/record:/);
    expect((await record.readRecordExport(ref)).entries).toBe(0);
  });

  it('derives one stable, spec-valid run id per chain', () => {
    const task = record.serverRunId({ podId: POD, taskId: 'TASK-1' });
    expect(task).toMatch(/^srv-task-[0-9a-f]{32}$/);
    expect(record.serverRunId({ podId: POD, taskId: 'TASK-1' })).toBe(task);
    expect(record.serverRunId({ podId: POD, taskId: 'TASK-10' })).not.toBe(task);
    expect(record.serverRunId({ podId: POD })).toMatch(/^srv-pod-[0-9a-f]{32}$/);
    expect(record.serverRunId({ podId: '6a692a1be833c668acdb84ce', taskId: 'TASK-1' })).not.toBe(task);
  });

  it('is on only for listed pods, or every pod with *', () => {
    delete process.env.RECORD_V1_PODS;
    expect(record.isRecordEnabled(POD)).toBe(false);
    process.env.RECORD_V1_PODS = ` other , ${POD} `;
    expect(record.isRecordEnabled(POD)).toBe(true);
    expect(record.isRecordEnabled('another')).toBe(false);
    process.env.RECORD_V1_PODS = '*';
    expect(record.isRecordEnabled('anything')).toBe(true);
  });

  it('takes the actor from the authenticated caller and never guesses one', () => {
    expect(record.requestActor({ agentUser: AGENT, agentTokenHash: 'h' })).toEqual({
      type: 'agent', id: AGENT._id, owner: AGENT.botMetadata.ownerUserId,
    });
    // A legacy installation token can authenticate without resolving a bot user.
    expect(record.requestActor({ agentTokenHash: 'h' })).toBeNull();
    expect(record.requestActor({ userId: '6a47891ee025ce2e0ca1d30b' })).toEqual({ type: 'human', id: '6a47891ee025ce2e0ca1d30b' });
    expect(record.requestActor({ user: { _id: 'has space' } })).toBeNull();
    // An owner that is the agent itself, or not an id, is left off.
    expect(record.agentActor({ _id: AGENT._id, botMetadata: { ownerUserId: AGENT._id } })).toEqual({ type: 'agent', id: AGENT._id });
  });

  describe('emitRecord', () => {
    it('writes nothing for a pod that is not enabled', async () => {
      repository.appendToChain.mockClear();
      record.emitRecord({ podId: 'not-enabled', taskId: 'TASK-1' }, 'k', [{ kind: 'task.claimed', actor: null }]);
      await record.flushRecordWrites();
      expect(repository.appendToChain).not.toHaveBeenCalled();
    });

    it('keeps one process in source order even when an earlier append is slower', async () => {
      const ref = { podId: POD, taskId: 'TASK-4' };
      const real = repository.appendToChain.getMockImplementation();
      repository.appendToChain.mockImplementationOnce(async (...args) => {
        await new Promise((resolve) => { setTimeout(resolve, 30); });
        return real(...args);
      });
      record.emitRecord(ref, 'first', [{ kind: 'task.claimed', actor: null }]);
      record.emitRecord(ref, 'second', [{ kind: 'task.done', actor: record.BOARD_ACTOR }]);
      await record.flushRecordWrites();
      const out = await record.readRecordExport(ref);
      expect(out.jsonl.trimEnd().split('\n').map((line) => JSON.parse(line).kind)).toEqual(['task.claimed', 'task.done']);
    });

    it('never throws into the source write, and logs one bounded line with no data', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      repository.appendToChain.mockRejectedValueOnce(Object.assign(new Error(`boom ${'x'.repeat(500)}`), { code: 'ECONNREFUSED' }));
      expect(() => record.emitRecord({ podId: POD, taskId: 'TASK-5' }, 'k', [
        { kind: 'task.done', actor: record.BOARD_ACTOR, data: { doneBy: 'secret-should-not-log' } },
      ])).not.toThrow();
      await record.flushRecordWrites();
      expect(warn).toHaveBeenCalledTimes(1);
      const [message] = warn.mock.calls[0];
      expect(message).toMatch(/^\[record\] append failed pod=6a692a1be833c668acdb84cf task=TASK-5 kinds=task\.done: ECONNREFUSED boom/);
      expect(message).not.toMatch(/secret-should-not-log/);
      expect(message.length).toBeLessThan(300);
    });
  });

  it('exports OTLP deterministically, with the task as the trace', async () => {
    const ref = { podId: POD, taskId: 'TASK-6' };
    await record.appendRecord(ref, 'e1', [{ kind: 'task.claimed', actor: record.agentActor(AGENT) }]);
    const { jsonl } = await record.readRecordExport(ref);
    const first = JSON.stringify(record.toOtlp(jsonl));
    expect(JSON.stringify(record.toOtlp(jsonl))).toBe(first);
    const [span] = record.toOtlp(jsonl).resourceSpans[0].scopeSpans[0].spans;
    expect(span.name).toBe('seats.run');
    expect(span.attributes).toEqual(expect.arrayContaining([{ key: 'seats.task.id', value: { stringValue: 'TASK-6' } }]));
  });
});
