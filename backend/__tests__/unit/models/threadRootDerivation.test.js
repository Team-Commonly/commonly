/**
 * thread_root_id is derived on write and carries no addressing (W-T, TASK-029).
 *
 * The property that matters most is the SEPARATION, not the derivation: the
 * root must never acquire the addressing semantics reply_to_message_id has.
 * `reply_to_message_id` feeds `isRouted` (agentMentionService:1025) and the
 * implicit-reply chat.mention (:1356), so if thread membership rode that
 * column, joining a thread would ping the parent's author — the opposite of
 * what ambient scoping is for.
 *
 * These assert the SQL the write path actually issues, because the derivation
 * is a subquery inside the INSERT rather than JS: there is no function to call.
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '../../../models/pg/Message.ts'),
  'utf8',
);
const SCHEMA = fs.readFileSync(
  path.join(__dirname, '../../../config/schema.sql'),
  'utf8',
);

describe('schema', () => {
  it('thread_root_id exists and is a separate column from the reply edge', () => {
    expect(SCHEMA).toMatch(/thread_root_id INTEGER REFERENCES messages\(id\) ON DELETE SET NULL/);
    expect(SCHEMA).toMatch(/reply_to_message_id INTEGER REFERENCES messages\(id\) ON DELETE SET NULL/);
  });

  it('is indexed — the reason the root is stored rather than walked', () => {
    expect(SCHEMA).toMatch(/CREATE INDEX IF NOT EXISTS idx_messages_thread_root_id ON messages\(thread_root_id\)/);
  });

  it('ON DELETE SET NULL, so deleting a root unthreads rather than orphaning', () => {
    const line = SCHEMA.split('\n').find((l) => l.includes('thread_root_id INTEGER'));
    expect(line).toContain('ON DELETE SET NULL');
  });
});

describe('derivation on write', () => {
  it('takes COALESCE(parent.thread_root_id, parent.id) — one level covers any depth', () => {
    // A reply to a root gets that root's id; a reply to a reply inherits the
    // root its parent already stored. Without the COALESCE, depth-3+ replies
    // would take their immediate parent as the root and split one thread into
    // many. Measured max depth on live data: 7.
    expect(SRC).toMatch(/COALESCE\(parent\.thread_root_id, parent\.id\)/);
  });

  it('derives from the reply edge and nothing else', () => {
    const insert = SRC.slice(SRC.indexOf('INSERT INTO messages'), SRC.indexOf('RETURNING *'));
    expect(insert).toContain('thread_root_id');
    expect(insert).toMatch(/WHERE parent\.id = \$5/); // $5 is replyToMessageId
  });

  it('a message with no reply edge gets a NULL root, not its own id', () => {
    // A root's own thread_root_id stays NULL. If roots pointed at themselves,
    // "is this threaded" would stop being expressible as IS NULL, and every
    // ambient message in the pod would look like a one-message thread.
    const insert = SRC.slice(SRC.indexOf('INSERT INTO messages'), SRC.indexOf('RETURNING *'));
    expect(insert).not.toMatch(/COALESCE\([^)]*\bid\b[^)]*\)\s*AS\s+thread_root/i);
    expect(insert).toContain('SELECT COALESCE(parent.thread_root_id, parent.id)');
  });
});

describe('the separation from addressing', () => {
  it('the schema records WHY the two columns cannot be one', () => {
    // This comment is the guard. A future reader seeing two columns that both
    // reference messages(id) will reasonably try to collapse them.
    expect(SCHEMA).toMatch(/ADDRESSING edge/);
    expect(SCHEMA).toMatch(/thread_root_id carries no\s*--?\s*addressing/);
  });

  it('the write path does not touch reply_to_message_id semantics', () => {
    // Derivation READS the parent's root; it must not write or alter any
    // addressing field.
    const insert = SRC.slice(SRC.indexOf('INSERT INTO messages'), SRC.indexOf('RETURNING *'));
    expect(insert).not.toMatch(/UPDATE|SET reply_to/);
  });
});
