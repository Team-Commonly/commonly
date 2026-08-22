/**
 * Explicit thread root vs derived, EXECUTED on pg-mem (W-T, TASK-029).
 *
 * @ux-lead 56879: an in-thread post carries no reply edge, so the client names
 * the root; explicit replies and the backfill still derive from reply_to.
 * Explicit wins when present, derivation fills when absent, mismatch is a 400.
 *
 * Every case runs the real resolver against real rows — the whole subject is
 * what the reconciliation DOES with two possibly-disagreeing inputs.
 */
const { newDb } = require('pg-mem');
const { createTableFor } = require('../../utils/schemaTable');

const mockDb = newDb();
const mockPool = new (mockDb.adapters.createPg().Pool)();
jest.mock('../../../config/db-pg', () => ({ pool: mockPool }));

const { resolveThreadRoot, ThreadRootError } = require('../../../services/threadRootResolver');

const POD = 'pod-1';
const OTHER = 'pod-2';

const msg = async (id, podId, rootId = null, replyTo = null) => {
  await mockPool.query(
    `INSERT INTO messages (id, pod_id, user_id, content, reply_to_message_id, thread_root_id)
     VALUES ($1,$2,'u','m',$3,$4)`,
    [id, podId, replyTo, rootId],
  );
};

beforeAll(async () => {
  await mockPool.query(createTableFor('pods'));
  await mockPool.query(createTableFor('messages'));
  for (const p of [POD, OTHER]) {
    await mockPool.query("INSERT INTO pods (id,name,type,created_by) VALUES ($1,'p','chat','u')", [p]);
  }
  await msg(100, POD);              // a root
  await msg(101, POD, 100, 100);    // a reply inside thread 100
  await msg(200, POD);              // another root
  await msg(300, OTHER);            // a root in a different pod
});

describe('derivation, when no root is named', () => {
  test('a reply to a root derives that root', async () => {
    expect(await resolveThreadRoot({ podId: POD, replyToMessageId: 100 })).toBe(100);
  });

  test('a reply to a reply inherits the stored root', async () => {
    expect(await resolveThreadRoot({ podId: POD, replyToMessageId: 101 })).toBe(100);
  });

  test('no reply edge and no named root starts no thread', async () => {
    expect(await resolveThreadRoot({ podId: POD })).toBeNull();
  });
});

describe('explicit, the in-thread post shape', () => {
  test('a named root with NO reply edge is honoured', async () => {
    // The case the amendment exists for: joins the thread, addresses nobody.
    expect(await resolveThreadRoot({ podId: POD, threadRootId: 100 })).toBe(100);
  });

  test('explicit wins over derivation when both agree', async () => {
    expect(await resolveThreadRoot({ podId: POD, replyToMessageId: 101, threadRootId: 100 })).toBe(100);
  });
});

describe('validation — each of these is a 400, not a silent choice', () => {
  const expectCode = async (args, code) => {
    await expect(resolveThreadRoot(args)).rejects.toMatchObject({ name: 'ThreadRootError', code });
  };

  test('a root that does not exist', async () => {
    await expectCode({ podId: POD, threadRootId: 999999 }, 'thread_root_not_found');
  });

  test('a root in another pod', async () => {
    // Otherwise a caller attaches a message to a conversation they may not be
    // able to read, and the wake set is computed from the thread, not the pod.
    await expectCode({ podId: POD, threadRootId: 300 }, 'thread_root_wrong_pod');
  });

  test('a root that is itself inside a thread — no nesting', async () => {
    // Two ids for one conversation would split every consumer that groups by
    // root. The error names the real root so the caller can just use it.
    await expectCode({ podId: POD, threadRootId: 101 }, 'thread_root_not_a_root');
  });

  test('reply edge and named root disagree', async () => {
    // 101 is in thread 100, so claiming thread 200 is a contradiction. Picking
    // a winner would hide a wrong belief about the conversation.
    await expectCode({ podId: POD, replyToMessageId: 101, threadRootId: 200 }, 'thread_root_mismatch');
  });

  test('a non-integer root', async () => {
    await expectCode({ podId: POD, threadRootId: 'abc' }, 'thread_root_invalid');
  });

  test('CONTROL: the same calls succeed with valid input', async () => {
    // Without this, every rejection above could come from a resolver that
    // rejects everything.
    expect(await resolveThreadRoot({ podId: POD, threadRootId: 100 })).toBe(100);
    expect(await resolveThreadRoot({ podId: POD, replyToMessageId: 101, threadRootId: 100 })).toBe(100);
  });
});

describe('the error type carries a code, so the route need not parse text', () => {
  test('ThreadRootError is exported and code-bearing', async () => {
    const err = await resolveThreadRoot({ podId: POD, threadRootId: 999999 }).catch((e) => e);
    expect(err).toBeInstanceOf(ThreadRootError);
    expect(typeof err.code).toBe('string');
  });
});
