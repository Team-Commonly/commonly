/**
 * Initiative v1 row 2: status is derived from evidence records only
 * (docs/plans/initiative-primitive.md §2). One case per status row, plus the
 * two negatives the design names: an owner's task update must NOT move an
 * initiative, and a merged initiative must read `needs your check`, not stall.
 *
 * The last block drives the real merge webhook writer and feeds what it pushes
 * to the reader, so the two cannot drift apart while this suite stays green.
 */
const mockTaskUpdate = jest.fn();
jest.mock('../../../models/GithubGigBinding', () => ({ findOne: jest.fn() }));
jest.mock('../../../models/Task', () => ({ findOneAndUpdate: (...args) => mockTaskUpdate(...args) }));
jest.mock('../../../services/agentIdentityService', () => ({ getOrCreateAgentUser: jest.fn() }));
jest.mock('../../../services/agentMessageService', () => ({ _postToTarget: jest.fn() }));
jest.mock('../../../services/taskEventService', () => ({ emitTaskUpdated: jest.fn() }));

const {
  deriveInitiativeStatus, mergeEvidenceDates, MERGE_EVIDENCE_TEXT,
} = require('../../../services/initiativeStatus');
const { completeTaskForMergedPull } = require('../../../services/githubGigService');

const NOW = new Date('2026-10-26T12:00:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600 * 1000);
const GIVER = 'giver-1';
const OWNER = 'owner-1';
const PR = 'https://github.com/Team-Commonly/commonly/pull/42';

const merge = (at) => ({ text: MERGE_EVIDENCE_TEXT, author: 'system', authorId: null, createdAt: at });
const ownerNote = (at) => ({ text: 'Lease renewed, still working', author: 'pike', authorId: 'seat-1', createdAt: at });
const task = (id, status, updates = [], prUrl = null) => ({ _id: id, status, updates, prUrl });
const initiative = (links, extra = {}) => ({
  createdAt: hoursAgo(24 * 10), direction: GIVER, ownerId: OWNER, links, ...extra,
});
const link = (kind, ref, addedAt = hoursAgo(24 * 9)) => ({ kind, ref, addedAt });
const none = { tasks: [], decisions: [], attention: [] };

describe('deriveInitiativeStatus — one case per status row', () => {
  it('moving: a merge inside the 24 h window', () => {
    const r = deriveInitiativeStatus(
      initiative([link('task', 't1'), link('task', 't2')]),
      { ...none, tasks: [task('t1', 'done', [merge(hoursAgo(3))]), task('t2', 'claimed')] },
      NOW,
    );
    expect(r.status).toBe('moving');
    expect(r.activity).toEqual({ state: 'moving', since: hoursAgo(3) });
  });

  it('moving: a ruled decision inside the window', () => {
    const r = deriveInitiativeStatus(
      initiative([link('decision', 'd1')]),
      { ...none, decisions: [{ _id: 'd1', title: 'Pick A', status: 'ruled', ruling: { at: hoursAgo(1) } }] },
      NOW,
    );
    expect(r.status).toBe('moving');
    expect(r.evidence).toEqual([{ kind: 'decision', linkKind: 'decision', ref: 'd1', at: hoursAgo(1) }]);
  });

  it('stalled since <date>: newest evidence is older than the window, dated by that evidence', () => {
    const r = deriveInitiativeStatus(
      initiative([link('task', 't1'), link('task', 't2')]),
      { ...none, tasks: [task('t1', 'done', [merge(hoursAgo(50))]), task('t2', 'pending')] },
      NOW,
    );
    expect(r.status).toBe('stalled');
    expect(r.activity).toEqual({ state: 'stalled', since: hoursAgo(50) });
  });

  it('stalled since createdAt when there is no evidence at all', () => {
    const r = deriveInitiativeStatus(initiative([link('task', 't1')]), { ...none, tasks: [task('t1', 'claimed')] }, NOW);
    expect(r.status).toBe('stalled');
    expect(r.activity.since).toEqual(hoursAgo(24 * 10));
  });

  it('blocked on X: a linked decision is pending, X is its title', () => {
    const r = deriveInitiativeStatus(
      initiative([link('decision', 'd1'), link('task', 't1')]),
      {
        ...none,
        tasks: [task('t1', 'done', [merge(hoursAgo(2))])],
        decisions: [{ _id: 'd1', title: 'Which vault?', status: 'pending' }],
      },
      NOW,
    );
    expect(r.status).toBe('blocked');
    expect(r.blockedOn).toEqual([{ decisionId: 'd1', title: 'Which vault?' }]);
    expect(r.activity.state).toBe('moving');
  });

  it('waiting on you: the pending decision has an open decision item for the giver', () => {
    const attention = [
      { kind: 'decision', status: 'open', recipientUserId: GIVER, source: { type: 'decision_request', id: 'd1' } },
    ];
    const r = deriveInitiativeStatus(
      initiative([link('decision', 'd1')]),
      { ...none, decisions: [{ _id: 'd1', title: 'Positioning', status: 'pending' }], attention },
      NOW,
    );
    expect(r.status).toBe('waiting-on-you');
    expect(r.waitingOnYou).toEqual([{ decisionId: 'd1', title: 'Positioning' }]);
  });

  it('a decision item addressed to someone else is blocked, not waiting on you', () => {
    const attention = [
      { kind: 'decision', status: 'open', recipientUserId: 'someone-else', source: { type: 'decision_request', id: 'd1' } },
      { kind: 'decision', status: 'done', recipientUserId: GIVER, source: { type: 'decision_request', id: 'd1' } },
    ];
    const r = deriveInitiativeStatus(
      initiative([link('decision', 'd1')]),
      { ...none, decisions: [{ _id: 'd1', title: 'Positioning', status: 'pending' }], attention },
      NOW,
    );
    expect(r.status).toBe('blocked');
    expect(r.waitingOnYou).toEqual([]);
  });

  it('needs your check: every linked task done and a PR merged, with no close; never a stall', () => {
    const r = deriveInitiativeStatus(
      initiative([link('task', 't1'), link('pr', PR)]),
      { ...none, tasks: [task('t1', 'done'), task('t2', 'done', [merge(hoursAgo(24 * 5))], PR)] },
      NOW,
    );
    expect(r.status).toBe('needs-your-check');
    expect(r.needsCheck).toBe(true);
    // The evidence is old, yet the status is not a stall.
    expect(r.activity.state).toBe('stalled');
  });

  it('closed: a close record by the giver', () => {
    const closed = { at: hoursAgo(1), byUserId: GIVER, evidenceUrl: 'https://example.test/walk', note: 'walked' };
    const r = deriveInitiativeStatus(initiative([link('task', 't1')], { closed }), { ...none, tasks: [task('t1', 'done')] }, NOW);
    expect(r.status).toBe('closed');
    expect(r.needsCheck).toBe(false);
  });

  it('closed by owner: the owner is also the giver', () => {
    const closed = { at: hoursAgo(1), byUserId: GIVER, evidenceUrl: 'https://example.test/walk' };
    const r = deriveInitiativeStatus(initiative([], { closed, ownerId: GIVER }), none, NOW);
    expect(r.status).toBe('closed-by-owner');
  });
});

describe('deriveInitiativeStatus — precedence overlaps (§2)', () => {
  const recent = [task('t1', 'done', [merge(hoursAgo(1))])];

  it('a pending decision beside recent evidence is blocked', () => {
    const r = deriveInitiativeStatus(
      initiative([link('task', 't1'), link('decision', 'd1')]),
      { ...none, tasks: recent, decisions: [{ _id: 'd1', title: 'Which vault?', status: 'pending' }] },
      NOW,
    );
    expect(r.activity.state).toBe('moving');
    expect(r.status).toBe('blocked');
  });

  it('a close beside recent evidence and a pending decision is closed', () => {
    const closed = { at: hoursAgo(1), byUserId: GIVER, evidenceUrl: 'https://example.test/walk' };
    const r = deriveInitiativeStatus(
      initiative([link('task', 't1'), link('decision', 'd1')], { closed }),
      { ...none, tasks: recent, decisions: [{ _id: 'd1', title: 'Which vault?', status: 'pending' }] },
      NOW,
    );
    expect(r.status).toBe('closed');
  });

  it('all merged beside recent evidence is needs your check, not moving', () => {
    const r = deriveInitiativeStatus(initiative([link('task', 't1')]), { ...none, tasks: recent }, NOW);
    expect(r.activity.state).toBe('moving');
    expect(r.status).toBe('needs-your-check');
  });
});

describe('deriveInitiativeStatus — what does NOT count', () => {
  it("an owner's task update inside the window does not move a stalled initiative", () => {
    const before = deriveInitiativeStatus(
      initiative([link('task', 't1')]),
      { ...none, tasks: [task('t1', 'claimed', [merge(hoursAgo(72))])] },
      NOW,
    );
    const after = deriveInitiativeStatus(
      initiative([link('task', 't1')]),
      { ...none, tasks: [task('t1', 'claimed', [merge(hoursAgo(72)), ownerNote(hoursAgo(1))])] },
      NOW,
    );
    expect(before.status).toBe('stalled');
    expect(after).toEqual(before);
  });

  it('other system-authored task updates are not merge evidence', () => {
    const starter = { text: 'Starter task created', author: 'system', authorId: null, createdAt: hoursAgo(1) };
    const spoofed = { text: MERGE_EVIDENCE_TEXT, author: 'system', authorId: 'seat-1', createdAt: hoursAgo(1) };
    const r = deriveInitiativeStatus(
      initiative([link('task', 't1')]),
      { ...none, tasks: [task('t1', 'claimed', [starter, spoofed])] },
      NOW,
    );
    expect(r.status).toBe('stalled');
    expect(r.evidence).toEqual([]);
  });

  it('a self-reported done (via /complete, no merge record) is not needs-your-check', () => {
    const r = deriveInitiativeStatus(
      initiative([link('task', 't1')]),
      { ...none, tasks: [task('t1', 'done', [ownerNote(hoursAgo(1))])] },
      NOW,
    );
    expect(r.status).toBe('stalled');
    expect(r.needsCheck).toBe(false);
  });

  it('a close written by anyone but the giver is ignored', () => {
    const closed = { at: hoursAgo(1), byUserId: OWNER, evidenceUrl: 'https://example.test/walk' };
    const r = deriveInitiativeStatus(
      initiative([link('task', 't1')], { closed }),
      { ...none, tasks: [task('t1', 'done', [merge(hoursAgo(2))])] },
      NOW,
    );
    expect(r.status).toBe('needs-your-check');
  });

  it("a task the owner flagged blocked stays a note on its part, not the status", () => {
    const r = deriveInitiativeStatus(
      initiative([link('task', 't1'), link('task', 't2')]),
      { ...none, tasks: [task('t1', 'blocked'), task('t2', 'done', [merge(hoursAgo(2))])] },
      NOW,
    );
    expect(r.status).toBe('moving');
    expect(r.parts.find((p) => p.ref === 't1')).toMatchObject({ state: 'stalled', ownerFlaggedBlocked: true });
  });
});

describe('deriveInitiativeStatus — parts and cadence', () => {
  it('shows a stalled part inside a moving initiative, dated by the link when it has no evidence', () => {
    const r = deriveInitiativeStatus(
      initiative([link('task', 't1'), link('task', 't2', hoursAgo(30))]),
      { ...none, tasks: [task('t1', 'claimed', [merge(hoursAgo(2))]), task('t2', 'pending')] },
      NOW,
    );
    expect(r.status).toBe('moving');
    expect(r.parts).toEqual([
      { kind: 'task', ref: 't1', state: 'moving', since: hoursAgo(2) },
      { kind: 'task', ref: 't2', state: 'stalled', since: hoursAgo(30) },
    ]);
  });

  it('the window is a per-initiative setting', () => {
    const records = { ...none, tasks: [task('t1', 'claimed', [merge(hoursAgo(30))])] };
    expect(deriveInitiativeStatus(initiative([link('task', 't1')]), records, NOW).status).toBe('stalled');
    expect(deriveInitiativeStatus(initiative([link('task', 't1')], { cadence: { windowHours: 48 } }), records, NOW).status)
      .toBe('moving');
  });
});

describe('the merge webhook writes exactly what the derivation reads', () => {
  it('feeds the update completeTaskForMergedPull pushes into mergeEvidenceDates', async () => {
    mockTaskUpdate.mockResolvedValue(null);
    await completeTaskForMergedPull('aaaaaaaaaaaaaaaaaaaaaaaa', PR);
    const pushed = mockTaskUpdate.mock.calls[0][1].$push.updates;
    expect(mergeEvidenceDates(task('t1', 'done', [pushed], PR))).toHaveLength(1);
  });
});
