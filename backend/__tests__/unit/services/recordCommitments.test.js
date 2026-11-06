/**
 * F265, the delete path: a person's id never reaches a line's hashed bytes, so
 * deleting it leaves every chain verifying. The real writer, the real emitters'
 * line builders, and an in-memory store with the repository's contract.
 */
const { canonicalLine, commitId, hashLine, isCommitment, readRecord, verifyRecord } = require('../../../vendor/seats/src/record/format');
const { commitRecordLine } = require('../../../services/recordCommitments');
const lines = require('../../../services/brokerRecordLines');
const { taskTransitionLine } = require('../../../services/taskRecordService');
const { buildRecordView } = require('../../../services/recordRedaction');

const mockStore = { lines: [], openings: [] };
jest.mock('../../../repositories/recordChainRepository', () => ({
  ...jest.requireActual('../../../repositories/recordChainRepository'),
  appendToChain: jest.fn(async (_ref, runId, _key, build) => {
    const { lines: built, openings } = build(mockStore.lines.at(-1) || null, runId);
    built.forEach((line, index) => {
      mockStore.lines.push(line);
      (openings[index] || []).forEach((row) => mockStore.openings.push({ ...row, seq: mockStore.lines.length }));
    });
    return { appended: built.length, duplicate: false };
  }),
  readChain: jest.fn(async () => ({
    runId: 'srv-pod-0000000001', headSeq: mockStore.lines.length, headHash: jest.requireActual('../../../vendor/seats/src/record/format').hashLine(mockStore.lines.at(-1)),
    lines: [...mockStore.lines], openings: [...mockStore.openings], openingsTotal: mockStore.openings.length, nextAfter: null,
  })),
}));
const { appendRecord, readRecordExport, readRecordView, toOtlp } = require('../../../services/recordService');

const POD = 'a'.repeat(24);
const REF = { podId: POD, taskId: 'TASK-1' };
const BEN = 'b'.repeat(24); // credential owner, approver
const ANA = 'c'.repeat(24); // owns the agent, claims a task
const EVE = 'd'.repeat(24); // a joiner
const AGENT = 'e'.repeat(24);
const agent = { type: 'agent', id: AGENT, owner: ANA };
const call = { toolCallId: 'tc-1', tool: 'sentry.write', grantId: 'g-1', agent };
const grant = {
  grantId: 'g-1', connectionId: 'conn-ben', tools: ['sentry.write'], writeMode: 'write', audience: [ANA, BEN], target: { kind: 'pod', id: POD },
};

// Every line a server writer emits, by the function that emits it.
const EVERY_LINE = [
  ['task.claimed by a person', taskTransitionLine({ from: 'pending', to: 'claimed', actor: { type: 'human', id: ANA }, at: new Date() })],
  ['task.claimed by an agent', taskTransitionLine({ from: 'pending', to: 'claimed', actor: agent, at: new Date() })],
  ['task.released', taskTransitionLine({ from: 'claimed', to: 'blocked', actor: { type: 'human', id: ANA }, at: new Date() })],
  ['task.done', taskTransitionLine({ from: 'claimed', to: 'done', doneBy: ANA, at: new Date() })],
  ['grant.issued by a person', lines.grantIssuedLine(grant, { type: 'human', id: BEN })],
  ['grant.issued by an agent', lines.grantIssuedLine({ ...grant, parentGrantId: 'g-0' }, agent)],
  ['grant.revoked', lines.grantRevokedLine(['g-1'], 'manual', { type: 'human', id: BEN })],
  ...[
    ['refused', lines.refusedCallLines(call)],
    ['parked', lines.parkedCallLines(call, BEN, 'card-1')],
    ['resolved', lines.resolvedCallLines(call, true, BEN, 'card-1')],
    ['declined', lines.resolvedCallLines(call, false, BEN, 'card-1')],
    ['expired', lines.expiredCallLines(call, 'card-1')],
    ['executed', lines.executedCallLines(call, true)],
  ].flatMap(([name, group]) => group.map((line) => [`${name}: ${line.kind}`, line])),
  ['outcome unknown', lines.unknownOutcomeUpdate(call)],
];

beforeEach(() => {
  mockStore.lines = [];
  mockStore.openings = [];
});

describe('every line a server writer emits', () => {
  test.each(EVERY_LINE)('%s holds no person in its bytes', async (_name, input) => {
    await appendRecord(REF, 'e', [input]);
    const [stored] = mockStore.lines;
    expect(stored).not.toContain(BEN);
    expect(stored).not.toContain(ANA);
    expect(stored).not.toContain('conn-ben');
    expect(verifyRecord(`${stored}\n`).errors).toEqual([]);
  });

  test('the list above covers every kind the server writes, so a new kind fails here until it is added', () => {
    expect([...new Set(EVERY_LINE.map(([, input]) => input.kind))].sort()).toEqual([
      'grant.issued', 'grant.revoked', 'permission.decided', 'permission.requested',
      'task.claimed', 'task.done', 'task.released', 'tool.call', 'tool.update',
    ]);
  });
});

describe('commitRecordLine', () => {
  test('one person twice gets two commitments, so lines can\'t be matched to each other', () => {
    const { input, openings } = commitRecordLine(lines.grantIssuedLine(grant, { type: 'human', id: BEN }));
    expect(input.actor.id).not.toBe(input.data.issuedBy);
    expect(new Set(openings.map((row) => row.salt)).size).toBe(openings.length);
    openings.forEach((row) => expect(commitId(row.value, row.salt)).toBe(row.commitment));
  });

  test('a connection is forgotten with the person it belongs to, an agent issuer\'s owner included', () => {
    const owned = (issuer) => commitRecordLine(lines.grantIssuedLine(grant, issuer)).openings.find((row) => row.field === 'data.scope.connectionId');
    expect(owned({ type: 'human', id: BEN })).toMatchObject({ subject: BEN, value: 'conn-ben' });
    expect(owned(agent).subject).toBe(ANA);
  });

  test('a child grant\'s connection belongs to the grant\'s owner, not the agent that issued it, and the hint is never stored', () => {
    const child = lines.grantIssuedLine({ ...grant, parentGrantId: 'g-0', ownerId: BEN }, { type: 'agent', id: AGENT });
    const { input, openings } = commitRecordLine(child);
    expect(openings.find((row) => row.field === 'data.scope.connectionId')).toMatchObject({ subject: BEN, value: 'conn-ben' });
    expect(input).not.toHaveProperty('connectionOwner');
  });

  test('policies, the board and an agent\'s own id are not people, and stay', () => {
    const { input, openings } = commitRecordLine(lines.refusedCallLines(call)[2]);
    expect(input.data.decidedBy).toBe('policy');
    expect(openings).toEqual([]);
    expect(commitRecordLine({ kind: 'tool.call', actor: agent, data: {} }).input.actor.id).toBe(AGENT);
  });

  test('an id the writer would refuse stays plain, so the writer still refuses it', () => {
    expect(commitRecordLine({ kind: 'task.done', data: { doneBy: 'Ana Smith' } }).input.data.doneBy).toBe('Ana Smith');
  });
});

describe('deleting a person', () => {
  const write = async () => {
    await appendRecord(REF, 'e1', [lines.grantIssuedLine(grant, { type: 'human', id: BEN })]);
    await appendRecord(REF, 'e2', lines.parkedCallLines(call, BEN, 'card-1'));
    await appendRecord(REF, 'e3', lines.resolvedCallLines(call, true, BEN, 'card-1'));
    await appendRecord(REF, 'e4', [lines.toolUpdate(call, 'completed')]);
  };
  const forget = (subject) => { mockStore.openings = mockStore.openings.filter((row) => row.subject !== subject); };

  test('the chain verifies byte for byte, under the same head, and their id can be read nowhere', async () => {
    await write();
    const before = await readRecordExport(REF);
    expect(before.jsonl).toContain(BEN);
    const stored = [...mockStore.lines];
    forget(BEN);
    expect(mockStore.lines).toEqual(stored);
    const after = await readRecordExport(REF);
    expect(after.jsonl).not.toContain(BEN);
    expect(after.jsonl).not.toContain('conn-ben');
    expect(after.head).toBe(before.head);
    const result = verifyRecord(after.jsonl);
    expect(result.errors).toEqual([]);
    expect(result.partial).toBeUndefined();
    expect(JSON.stringify(toOtlp(after.jsonl))).not.toContain(BEN);
  });

  test('other people on the same chain keep their ids', async () => {
    await write();
    forget(BEN);
    expect((await readRecordExport(REF)).jsonl).toContain(ANA);
  });

  test('after deletion no guess can be tested: nothing a reader holds opens a commitment', async () => {
    await write();
    const salts = mockStore.openings.filter((row) => row.subject === BEN).map((row) => row.salt);
    forget(BEN);
    const { jsonl } = await readRecordExport(REF);
    expect(salts.length).toBeGreaterThan(0);
    salts.forEach((salt) => expect(jsonl).not.toContain(salt));
    const tokens = readRecord(jsonl).flatMap((entry) => Object.values(entry.data)).filter(isCommitment);
    tokens.forEach((token) => {
      [BEN, ANA, EVE].forEach((id) => {
        ['0'.repeat(32), ...mockStore.openings.map((row) => row.salt)].forEach((salt) => {
          expect(commitId(id, salt)).not.toBe(token);
        });
      });
    });
  });
});

describe('a joiner on an open pod', () => {
  const writeOne = () => appendRecord(REF, 'e', lines.resolvedCallLines(call, true, BEN, 'card-1'));

  test('reads the stored bytes, gets a whole check, and no held salt or id', async () => {
    await appendRecord(REF, 'e0', [lines.grantIssuedLine(grant, { type: 'human', id: BEN })]);
    await writeOne();
    const view = await readRecordView(REF, EVE);
    // The audience is opened to every member, as the grant read gives it out.
    const withoutOpenings = view.jsonl.trimEnd().split('\n').map((line) => {
      const { openings: _shown, ...stored } = JSON.parse(line);
      return canonicalLine(stored);
    });
    expect(withoutOpenings).toEqual(mockStore.lines);
    expect(verifyRecord(view.jsonl)).toMatchObject({ ok: true, errors: [] });
    expect(verifyRecord(view.jsonl).partial).toBeUndefined();
    expect(view.head).toBe(hashLine(mockStore.lines.at(-1)));
    expect(view.unopened).toBeGreaterThan(0);
    mockStore.openings.filter((row) => !row.field.startsWith('data.scope.audience.'))
      .forEach((row) => expect(view.jsonl).not.toContain(row.salt));
  });

  test('the audience opens to every member, as the grant read gives it, and the granter\'s line stays whole', async () => {
    await appendRecord(REF, 'e0', [lines.grantIssuedLine(grant, { type: 'human', id: BEN })]);
    const [line] = readRecord((await readRecordView(REF, EVE)).jsonl);
    expect(line.data.scope.audience).toEqual(grant.audience);
    expect(line.data.issuedBy).toMatch(/^c1:/);
    const own = await readRecordView(REF, BEN);
    expect(readRecord(own.jsonl)[0].data).toMatchObject({ issuedBy: BEN, scope: { connectionId: 'conn-ben', audience: grant.audience } });
    expect(verifyRecord(own.jsonl).errors).toEqual([]);
  });

  test('the worker\'s lines stay readable: a task\'s claimer and finisher are opened for a member', async () => {
    await appendRecord(REF, 'e', [
      taskTransitionLine({ from: 'pending', to: 'claimed', actor: { type: 'human', id: ANA }, at: new Date() }),
      taskTransitionLine({ from: 'claimed', to: 'done', doneBy: ANA, at: new Date() }),
    ]);
    const view = await readRecordView(REF, EVE);
    const [claimed, done] = readRecord(view.jsonl);
    expect(claimed.actor.id).toBe(ANA);
    expect(done.data.doneBy).toBe(ANA);
    expect(verifyRecord(view.jsonl).errors).toEqual([]);
  });

  test('a person reads their own id, and a check of that line still passes', async () => {
    await writeOne();
    const view = await readRecordView(REF, BEN);
    expect(readRecord(view.jsonl)[0].data.decidedBy).toBe(BEN);
    expect(verifyRecord(view.jsonl).errors).toEqual([]);
  });

  test('a commitment on a line after an older held-back line stays unopened, and the chain resumes', async () => {
    await appendRecord(REF, 'e', lines.resolvedCallLines(call, true, BEN, 'card-1'));
    const committed = [...mockStore.lines];
    const legacy = canonicalLine({ ...JSON.parse(committed[0]), data: { decidedBy: BEN, decidedByRole: 'credential-owner' } });
    const view = buildRecordView([legacy], EVE);
    expect(view.jsonl).not.toContain(BEN);
    expect(verifyRecord(view.jsonl).errors).toEqual([]);
  });
});

describe('a reader paging through a view', () => {
  const { readChain } = require('../../../repositories/recordChainRepository');
  const rebuilds = () => readChain.mock.calls.filter(([, , page]) => !page).length;
  const POD2 = { podId: 'f'.repeat(24), taskId: 'TASK-2' };
  beforeEach(async () => {
    readChain.mockClear();
    await appendRecord(POD2, 'a', lines.resolvedCallLines(call, true, BEN, 'card-1'));
  });

  test('builds the view once, however many pages it reads', async () => {
    await readRecordView(POD2, EVE, undefined, { after: 0, limit: 1 });
    await readRecordView(POD2, EVE, undefined, { after: 1, limit: 1 });
    await readRecordView(POD2, EVE, undefined, { after: 2, limit: 1 });
    expect(rebuilds()).toBe(1);
  });

  test('one reader\'s view never serves another', async () => {
    const ben = await readRecordView(POD2, BEN);
    const eve = await readRecordView(POD2, EVE);
    expect(ben.jsonl).toContain(BEN);
    expect(eve.jsonl).not.toContain(BEN);
  });

  test('a new line and a deleted id each show on the next read, with no wait', async () => {
    const first = await readRecordView(POD2, BEN);
    await appendRecord(POD2, 'b', [lines.toolUpdate(call, 'completed')]);
    const second = await readRecordView(POD2, BEN);
    expect(second.entries).toBe(first.entries + 1);
    mockStore.openings = mockStore.openings.filter((row) => row.subject !== BEN);
    expect((await readRecordView(POD2, BEN)).jsonl).not.toContain(BEN);
  });
});
