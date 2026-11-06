/**
 * F265: on a pod anyone can join, approver and credential-owner ids go only to
 * the person each one names, and the reader's own tamper check still passes.
 * Real format code, real line hashes; only the store is a fake.
 */
const { appendEntry, canonicalLine, commitId, hashLine, verifyRecord, readRecord } = require('../../../vendor/seats/src/record/format');
const { buildRecordView, isOpenPod, personIdFor, REDACTED_ID } = require('../../../services/recordRedaction');
const { readRecordView, toOtlp, newLineSalt } = require('../../../services/recordService');

const POD = 'a'.repeat(24);
const BEN = 'b'.repeat(24);
const ANA = 'c'.repeat(24);
const EVE = 'd'.repeat(24);
const AGENT = { type: 'agent', id: 'e'.repeat(24), owner: ANA };
const ENV = { runId: 'srv-pod-0000000001', podId: POD };
let clock = Date.UTC(2026, 10, 6, 12);

const chain = (salted = true) => {
  const lines = [];
  const add = (kind, data, actor) => lines.push(appendEntry(lines.at(-1) ?? null, {
    ...ENV, ts: new Date((clock += 7)).toISOString(), kind, data, ...(actor !== undefined ? { actor } : {}),
    ...(salted ? { salt: newLineSalt() } : {}),
  }));
  add('grant.issued', {
    grantId: 'g-1', scope: { connectionId: 'conn-1', tools: ['sentry.resolve_issue'], writeMode: 'write', audience: [AGENT.id] },
    target: { kind: 'pod', id: POD }, issuedBy: BEN,
  }, { type: 'human', id: BEN });
  add('tool.call', { toolCallId: 'tc-1', title: 'sentry.resolve_issue', name: 'sentry.resolve_issue', surface: 'connector' }, AGENT);
  add('permission.requested', {
    toolCallId: 'tc-1', options: [], question: 'sentry.resolve_issue', askedOf: { id: BEN, role: 'credential-owner' }, grantId: 'g-1', decisionCardId: 'card-1',
  }, AGENT);
  add('permission.decided', {
    outcome: 'selected', toolCallId: 'tc-1', rule: { list: 'ask', pattern: null }, approval: 'approved', decidedBy: BEN, decidedByRole: 'credential-owner', grantId: 'g-1', decisionCardId: 'card-1',
  });
  add('tool.update', { toolCallId: 'tc-1', status: 'completed' }, AGENT);
  add('permission.decided', {
    outcome: 'selected', toolCallId: 'tc-2', rule: { list: 'allow', pattern: null }, decidedBy: 'policy', decidedByRole: 'policy', grantId: 'g-1',
  });
  add('grant.revoked', { grantIds: ['g-1'], reason: 'manual' }, { type: 'human', id: BEN });
  return lines;
};
const text = (lines) => lines.map((line) => `${line}\n`).join('');
const served = (stored, viewer) => buildRecordView(stored, viewer);

describe('isOpenPod: what "anyone can join" means', () => {
  const listed = { type: 'team', publicRead: true, communityListed: true };
  afterEach(() => { delete process.env.COMMUNITY_POD_ID; });

  test('a listed pod not marked invite-only is open, a legacy row with no joinPolicy included', () => {
    expect(isOpenPod({ ...listed, joinPolicy: 'open' })).toBe(true);
    expect(isOpenPod(listed)).toBe(true);
  });

  test('invite-only, unlisted and DM pods are not, whatever joinPolicy says', () => {
    expect(isOpenPod({ ...listed, joinPolicy: 'invite-only' })).toBe(false);
    // `joinPolicy: 'open'` is the schema default on every pod; alone it admits nobody.
    expect(isOpenPod({ type: 'team', joinPolicy: 'open' })).toBe(false);
    expect(isOpenPod({ ...listed, type: 'agent-room' })).toBe(false);
  });

  test('the community pod every signup is added to counts, flags or no flags', () => {
    process.env.COMMUNITY_POD_ID = POD;
    expect(isOpenPod({ _id: POD, type: 'team' })).toBe(true);
    expect(isOpenPod({ _id: 'f'.repeat(24), type: 'team' })).toBe(false);
  });
});

describe('personIdFor', () => {
  const open = { type: 'team', publicRead: true, communityListed: true, createdBy: ANA };
  test('an open pod\'s creator sees every id', () => {
    expect(personIdFor(open, ANA, BEN)).toBe(BEN);
  });
  test('an open pod shows an id only to the person it names', () => {
    expect(personIdFor(open, EVE, BEN)).toBeNull();
    expect(personIdFor(open, BEN, BEN)).toBe(BEN);
  });
  test('any other pod shows it as today', () => {
    expect(personIdFor({ type: 'team' }, EVE, BEN)).toBe(BEN);
  });
});

describe('buildRecordView', () => {
  describe('a kind whose data is held back', () => {
    const SALT = 'f'.repeat(32);
    const token = commitId(EVE, SALT);
    const opening = (field, subject = EVE) => ({
      seq: 1, commitment: token, field, subject, value: EVE, salt: SALT,
    });
    // No kind held back today lets a writer put an id in its data, and a later
    // kind might: this is the line such a kind would store.
    const stored = (data, actor = { type: 'system', id: 'commonly' }) => [canonicalLine({
      ...JSON.parse(appendEntry(null, {
        ...ENV, ts: new Date((clock += 7)).toISOString(), kind: 'session.opened', actor, data: { method: 'new', sessionId: 's-1' }, salt: newLineSalt(),
      })),
      data,
    })];

    test('a commitment that went with the data takes its opening with it, for the person it names too', () => {
      const view = buildRecordView(stored({ decidedBy: token }), EVE, [opening('data.decidedBy')]);
      const [line] = view.lines;
      expect(JSON.parse(line)).not.toHaveProperty('openings');
      expect(line).not.toContain(EVE);
      expect(verifyRecord(view.jsonl).errors).toEqual([]);
      expect(view.unopened).toBe(1);
    });

    test('an audience entry on such a line stays closed, though audiences open on a grant', () => {
      const view = buildRecordView(stored({ scope: { audience: [token] } }), BEN, [opening('data.scope.audience.0')]);
      expect(view.jsonl).not.toContain(EVE);
      expect(verifyRecord(view.jsonl).errors).toEqual([]);
    });

    test('a commitment still on the served line keeps its opening', () => {
      const view = buildRecordView(stored({ note: 'x' }, { type: 'human', id: token }), EVE, [opening('actor.id')]);
      expect(readRecord(view.jsonl)[0].actor.id).toBe(EVE);
      expect(verifyRecord(view.jsonl).errors).toEqual([]);
    });
  });

  describe('a plain grant line\'s connection id', () => {
    const plain = (data, actor) => [appendEntry(null, {
      ...ENV, ts: new Date((clock += 7)).toISOString(), kind: 'grant.issued', actor, salt: newLineSalt(),
      data: {
        grantId: 'g-2', scope: { connectionId: 'conn-1', tools: ['sentry.resolve_issue'], writeMode: 'write', audience: [AGENT.id] }, target: { kind: 'pod', id: POD }, ...data,
      },
    })];
    const connectionFor = (line, viewer) => readRecord(buildRecordView(line, viewer).jsonl)[0].data.scope.connectionId;

    test('a person who minted a root grant owns the connection, and reads it', () => {
      expect(connectionFor(plain({ issuedBy: BEN }, { type: 'human', id: BEN }), BEN)).toBe('conn-1');
    });

    test('an agent\'s child grant may rest on someone else\'s connection, so neither it nor its owner reads the id', () => {
      const child = plain({ issuedBy: AGENT.id, parentGrantId: 'g-1' }, AGENT);
      expect(connectionFor(child, AGENT.id)).toBe(REDACTED_ID);
      expect(connectionFor(child, ANA)).toBe(REDACTED_ID);
    });

    test('a person issuing a child doesn\'t establish the connection is theirs', () => {
      expect(connectionFor(plain({ issuedBy: BEN, parentGrantId: 'g-1' }, { type: 'human', id: BEN }), BEN)).toBe(REDACTED_ID);
    });
  });

  test('no approver or credential-owner id reaches a reader they do not name, in any field', () => {
    const view = served(chain(), EVE);
    expect(view.jsonl).not.toContain(BEN);
    expect(view.jsonl).not.toContain('conn-1');
    const entries = readRecord(view.jsonl);
    expect(entries[0].actor.id).toBe(REDACTED_ID);
    expect(entries[0].data.issuedBy).toBe(REDACTED_ID);
    // The grant read gives every member the audience, so hiding it here hid nothing.
    expect(entries[0].data.scope.audience).toEqual([AGENT.id]);
    expect(entries[2].data.askedOf).toEqual({ id: REDACTED_ID, role: 'credential-owner' });
    expect(entries[3].actor.id).toBe(REDACTED_ID);
    expect(entries[3].data.decidedBy).toBe(REDACTED_ID);
    expect(entries[3].data.decidedByRole).toBe('credential-owner');
    expect(entries[6].actor.id).toBe(REDACTED_ID);
  });

  test('a salted chain: the reader\'s check passes, every other line is verbatim, the real head is shown', () => {
    const stored = chain();
    const view = served(stored, EVE);
    const result = verifyRecord(view.jsonl);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.partial).toBe(true);
    expect(result.redacted).toEqual([1, 3, 4, 7]);
    expect(result.unlinked).toEqual([]);
    expect(view.lines[1]).toBe(stored[1]);
    expect(view.lines[4]).toBe(stored[4]);
    expect(view.lines[5]).toBe(stored[5]);
    expect(view.headShown).toBe(true);
    expect(result.head).toBe(hashLine(stored[6]));
  });

  test('a salted hash is no use to a guesser: no salt is shown on a redacted line', () => {
    const stored = chain();
    const view = readRecord(served(stored, EVE).jsonl);
    [0, 2, 3, 6].forEach((index) => {
      expect(view[index].salt).toBeUndefined();
      expect(view[index].redaction.hash).toBe(hashLine(stored[index]));
    });
  });

  test('a person named on a line reads their own id; another\'s on the same line stays hidden', () => {
    const view = readRecord(served(chain(), BEN).jsonl);
    expect(view[0].data.issuedBy).toBe(BEN);
    expect(view[0].data.scope.connectionId).toBe('conn-1');
    expect(view[0].redaction).toBeUndefined();
    expect(view[3].data.decidedBy).toBe(BEN);
    expect(view[3].redaction).toBeUndefined();
    expect(verifyRecord(served(chain(), BEN).jsonl).errors).toEqual([]);
  });

  test('a policy decision names nobody and stays verbatim', () => {
    const stored = chain();
    expect(served(stored, EVE).lines[5]).toBe(stored[5]);
  });

  test('a kind this code does not know is held back whole, never passed through', () => {
    const line = canonicalLine({ ...JSON.parse(chain()[0]), kind: 'decision.delegated', actor: { type: 'human', id: BEN }, data: { to: BEN } });
    const view = readRecord(buildRecordView([line], EVE).jsonl)[0];
    expect(view.data).toEqual({});
    expect(view.actor.id).toBe(REDACTED_ID);
  });

  // The attack this design exists to stop: a member list plus any hash that
  // covers the line. Candidate lines are rebuilt from everything the view shows.
  describe('guessing an id against the hashes a view exposes', () => {
    const guess = (jsonl, stored, candidates) => {
      const shown = new Set([...jsonl.matchAll(/[0-9a-f]{64}/g)].map((match) => match[0]));
      const { salt, ...line } = JSON.parse(stored[3]);
      return candidates.filter((id) => shown.has(hashLine(canonicalLine({
        ...line, actor: { id, type: 'human' }, data: { ...line.data, decidedBy: id },
      }))));
    };

    test('a salted line shows its hash, and the guess still finds nothing', () => {
      const stored = chain();
      const view = served(stored, EVE);
      expect(view.jsonl).toContain(hashLine(stored[3]));
      expect(guess(view.jsonl, stored, [EVE, ANA, BEN])).toEqual([]);
    });

    test('a legacy unsalted line exposes no hash at or after it, so a guess has nothing to match', () => {
      const stored = chain(false);
      const view = served(stored, EVE);
      expect(guess(text(stored), stored, [EVE, ANA, BEN])).toEqual([BEN]); // the attack, on the stored lines
      expect(guess(view.jsonl, stored, [EVE, ANA, BEN])).toEqual([]);
      for (let index = 0; index < stored.length; index += 1) expect(view.jsonl).not.toContain(hashLine(stored[index]));
      expect(view.headShown).toBe(false);
    });

    test('a legacy chain\'s check still passes, and says every line from the first hold-back is unlinked', () => {
      const stored = chain(false);
      const result = verifyRecord(served(stored, EVE).jsonl);
      expect(result.errors).toEqual([]);
      expect(result.partial).toBe(true);
      expect(result.unlinked).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(result.head).toBeNull();
    });
  });

  test('a chain with nothing to hold back is served byte for byte, head and all', () => {
    const lines = [appendEntry(null, { ...ENV, ts: new Date().toISOString(), kind: 'tool.call', actor: AGENT, data: { toolCallId: 'tc', title: 't' } })];
    const view = served(lines, EVE);
    expect(view.jsonl).toBe(text(lines));
    expect(view.redacted).toBe(0);
    expect(view.headShown).toBe(true);
  });

  test('legacy lines then salted lines: the chain picks up again at the first salted line', () => {
    const legacy = chain(false);
    const next = appendEntry(legacy.at(-1), { ...ENV, ts: new Date((clock += 7)).toISOString(), kind: 'tool.update', actor: AGENT, data: { toolCallId: 'tc-9' }, salt: newLineSalt() });
    const last = appendEntry(next, { ...ENV, ts: new Date((clock += 7)).toISOString(), kind: 'tool.update', actor: AGENT, data: { toolCallId: 'tc-9' }, salt: newLineSalt() });
    const view = served([...legacy, next, last], EVE);
    const result = verifyRecord(view.jsonl);
    expect(result.errors).toEqual([]);
    expect(view.lines[8]).toBe(last);
    expect(view.headShown).toBe(true);
  });
});

describe('readRecordView', () => {
  const fakeDb = (stored) => ({
    query: async (sql, params) => {
      if (sql.includes('FROM record_chains')) {
        return { rows: [{ id: '1', run_id: ENV.runId, head_seq: stored.length, head_hash: hashLine(stored.at(-1)) }], rowCount: 1 };
      }
      if (sql.includes('FROM record_openings')) return { rows: [], rowCount: 0 };
      const [, after, head, limit] = params;
      const rows = stored.map((line, index) => ({ seq: index + 1, line })).filter(({ seq }) => seq > after && seq <= head).slice(0, limit);
      return { rows, rowCount: rows.length };
    },
  });

  test('pages concatenate into a view that passes, and no page shows a line another would hide', async () => {
    const stored = chain();
    const db = fakeDb(stored);
    let text2 = '';
    let after = 0;
    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const page = await readRecordView({ podId: POD }, EVE, db, { after, limit: 2 });
      text2 += page.jsonl;
      if (page.nextAfter === null) break;
      after = page.nextAfter;
    }
    expect(text2).not.toContain(BEN);
    const result = verifyRecord(text2);
    expect(result.errors).toEqual([]);
    expect(result.entries).toBe(stored.length);
  });

  test('the head is withheld when it would cover a line a guess could reach', async () => {
    const stored = chain(false);
    const page = await readRecordView({ podId: POD }, EVE, fakeDb(stored));
    expect(page.head).toBeNull();
    expect(page.unlinked).toBe(7);
  });

  test('the head and counts describe the whole chain on a salted chain', async () => {
    const stored = chain();
    const page = await readRecordView({ podId: POD }, EVE, fakeDb(stored), { limit: 1 });
    expect(page.head).toBe(hashLine(stored.at(-1)));
    expect(page.entries).toBe(7);
    expect(page.redacted).toBe(4);
    expect(page.nextAfter).toBe(1);
  });

  test('a chain that was never written reads as empty', async () => {
    const db = { query: async () => ({ rows: [], rowCount: 0 }) };
    expect((await readRecordView({ podId: POD }, EVE, db)).jsonl).toBe('');
  });

  test('OTLP of a view carries no hidden id, salt or hash', async () => {
    const stored = chain();
    const page = await readRecordView({ podId: POD }, EVE, fakeDb(stored), { limit: Infinity });
    const otlp = JSON.stringify(toOtlp(page.jsonl));
    expect(otlp).not.toContain(BEN);
    expect(otlp).not.toContain('conn-1');
    expect(otlp).not.toContain(JSON.parse(stored[1]).salt);
    expect(otlp).not.toContain(hashLine(stored[0]));
  });
});
