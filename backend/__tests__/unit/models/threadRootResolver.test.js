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
const { createTableFor, applyTable } = require('../../utils/schemaTable');

const mockDb = newDb();
const mockPool = new (mockDb.adapters.createPg().Pool)();
jest.mock('../../../config/db-pg', () => ({ pool: mockPool }));

const { resolveThreadRoot, ThreadRootError } = require('../../../services/threadRootResolver');
const PGMessageTop = require('../../../models/pg/Message');

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
  // applyTable, not createTableFor: `payload` and `thread_root_id` are added
  // by ALTER, so the CREATE alone is not the table this code talks to.
  await applyTable(mockPool, 'users');   // findById LEFT JOINs it
  await applyTable(mockPool, 'messages');
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

describe('the root survives the round trip the wake path actually takes', () => {
  /**
   * The gap this exists for: `findById` projects an explicit column list, and
   * `thread_root_id` was not in it. The controller does
   * `message = (populated || created)` and hands THAT to enqueueMentions, so
   * the ambient scoping hook in 3/4 read `undefined` for every message and
   * silently never scoped.
   *
   * Every 3/4 test passed throughout, because they construct the message
   * object directly with `thread_root_id` set and so never travel this path.
   * A test that builds the shape the code under test never receives cannot
   * find a projection bug — only a round trip can.
   */
  const PGMessage = require('../../../models/pg/Message');

  test('create -> findById preserves thread_root_id', async () => {
    const root = await PGMessage.create(POD, 'u', 'root', 'text', null);
    const reply = await PGMessage.create(POD, 'u', 'reply', 'text', String(root.id));
    expect(reply.thread_root_id).toBe(root.id);

    // The object the controller prefers, and the one the wake path sees.
    const populated = await PGMessage.findById(reply.id);
    expect(populated).toBeTruthy();
    expect(populated.thread_root_id).toBe(root.id);
  });

  test('and preserves an EXPLICIT root with no reply edge', async () => {
    // The shape @ux-lead's amendment makes primary: joins a thread, addresses
    // nobody. If the projection drops the column, this is the message whose
    // scoping silently disappears.
    const root = await PGMessage.create(POD, 'u', 'root2', 'text', null);
    const inThread = await PGMessage.create(POD, 'u', 'in-thread', 'text', null, null, root.id);
    expect(inThread.reply_to_message_id).toBeNull();
    expect(inThread.thread_root_id).toBe(root.id);

    const populated = await PGMessage.findById(inThread.id);
    expect(populated.thread_root_id).toBe(root.id);
  });

  test('a message with no thread still reads null, not undefined', async () => {
    // undefined and null are the same to the hook's truthiness check, but a
    // missing KEY hides a dropped column while an explicit null does not.
    const plain = await PGMessage.create(POD, 'u', 'plain', 'text', null);
    const populated = await PGMessage.findById(plain.id);
    expect(populated).toHaveProperty('thread_root_id');
    expect(populated.thread_root_id).toBeNull();
  });
});

describe('the resolver is not consulted when there is nothing to reconcile', () => {
  /**
   * It runs ONLY when the caller names a root. Without one it would re-derive
   * COALESCE(parent.thread_root_id, parent.id) — which the INSERT already does
   * — adding a query per message and changing nothing.
   *
   * Found by CI: calling it unconditionally added a query the controller tests
   * do not mock, and broke seven of them. I had run the model suites on this
   * branch and not the controller suite, which is the same miss as earlier the
   * same day. The redundancy was real independently of the breakage.
   */
  const CONTROLLER_SRC = require('fs').readFileSync(
    require('path').join(__dirname, '../../../controllers/messageController.ts'), 'utf8',
  );

  test('the controller gates the call on an explicit threadRootId', () => {
    const gate = CONTROLLER_SRC.indexOf("if (threadRootId != null && threadRootId !== '')");
    const call = CONTROLLER_SRC.indexOf('await resolveThreadRoot(');
    expect(gate).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(gate);
  });

  test('and still passes null through to create, so derivation runs in SQL', () => {
    // The no-explicit-root path must not become "no thread root" — it becomes
    // "let the INSERT derive it", which is a different thing.
    expect(CONTROLLER_SRC).toMatch(/let resolvedThreadRootId: number \| null = null;/);
    expect(CONTROLLER_SRC).toMatch(/resolvedThreadRootId,/);
  });

  test('a plain reply still gets its root, with the resolver never called', async () => {
    // The behavioural half: derivation is unaffected by the gate.
    const root = await PGMessageTop.create(POD, 'u', 'gate-root', 'text', null);
    const reply = await PGMessageTop.create(POD, 'u', 'gate-reply', 'text', String(root.id));
    expect(reply.thread_root_id).toBe(root.id);
  });
});
