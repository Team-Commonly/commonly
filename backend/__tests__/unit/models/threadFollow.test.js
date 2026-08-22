/**
 * Thread follow state (W-T, TASK-029, 2/4).
 *
 * The decisions worth pinning are about SHAPE, not SQL mechanics:
 *  - it is a separate record, not a widened User.followedThreads
 *  - follow/unfollow are idempotent, because a subscription is not a claim
 *  - the unique is (root, user) — many users may follow one thread
 *  - pod_id is denormalised convenience and deliberately NOT part of identity
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '../../../models/pg/ThreadFollow.ts'), 'utf8');
const SCHEMA = fs.readFileSync(path.join(__dirname, '../../../config/schema.sql'), 'utf8');
const USER = fs.readFileSync(path.join(__dirname, '../../../models/User.ts'), 'utf8');

describe('it is a separate record, not a widened followedThreads', () => {
  it('User.followedThreads is still typed to Post and untouched', () => {
    // The whole reason for a new table. If someone later widens this to accept
    // a message id, every Post.find({_id: {$in: postIds}}) consumer silently
    // drops the chat rows.
    expect(USER).toMatch(/postId:\s*\{\s*type:\s*Schema\.Types\.ObjectId,\s*ref:\s*'Post',\s*required:\s*true\s*\}/);
  });

  it('thread_follows references messages(id), which followedThreads cannot', () => {
    expect(SCHEMA).toMatch(/thread_root_id INTEGER NOT NULL REFERENCES messages\(id\) ON DELETE CASCADE/);
  });

  it('the schema records why, next to the table', () => {
    expect(SCHEMA).toMatch(/cannot hold a Postgres messages\.id/);
  });
});

describe('follow is a subscription, not a claim', () => {
  it('the unique is (root, user) — many users may follow one thread', () => {
    expect(SCHEMA).toMatch(/UNIQUE \(thread_root_id, user_id\)/);
    // NOT unique on thread_root_id alone, which would make following a claim.
    expect(SCHEMA).not.toMatch(/UNIQUE \(thread_root_id\)/);
  });

  it('following twice is idempotent, not an error', () => {
    expect(SRC).toMatch(/ON CONFLICT \(thread_root_id, user_id\) DO UPDATE/);
  });

  it('unfollowing what you do not follow is not an error either', () => {
    expect(SRC).toMatch(/static async unfollow/);
    expect(SRC).toMatch(/return rowCount > 0;/);
  });
});

describe('pod_id is convenience, never identity', () => {
  it('is stored for the per-pod read', () => {
    expect(SCHEMA).toMatch(/pod_id VARCHAR\(255\) NOT NULL/);
    expect(SCHEMA).toMatch(/idx_thread_follows_user_pod ON thread_follows\(user_id, pod_id\)/);
  });

  it('but is NOT part of the unique — the root already implies the pod', () => {
    const table = SCHEMA.slice(
      SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS thread_follows'),
      SCHEMA.indexOf('idx_thread_follows_root'),
    );
    expect(table).not.toMatch(/UNIQUE \([^)]*pod_id[^)]*\)/);
  });

  it('deleting a root cascades — a follow on a deleted thread is not a thing', () => {
    expect(SCHEMA).toMatch(/thread_root_id INTEGER NOT NULL REFERENCES messages\(id\) ON DELETE CASCADE/);
  });
});

describe('the wake path gets ids, not identities', () => {
  it('followerIds returns user ids and resolves nothing', () => {
    // The wake path and the UI want different shapes; neither should pay for
    // the other's join.
    expect(SRC).toMatch(/static async followerIds/);
    expect(SRC).toMatch(/rows\.map\(\(r\) => String\(r\.user_id\)\)/);
  });
});

describe('the module actually loads', () => {
  // Not ceremony. Every other assertion in this file reads source TEXT, which
  // is blind to a bad require path — the first draft of this model required
  // '../../config/postgres', a file that does not exist, and every text
  // assertion still passed. One real require is the cheapest control for the
  // failure mode the rest of the suite shares.
  it('exposes its four statics when required for real', () => {
    // eslint-disable-next-line global-require
    const ThreadFollow = require('../../../models/pg/ThreadFollow');
    for (const fn of ['follow', 'unfollow', 'followerIds', 'followedRootsForUser', 'isFollowing']) {
      expect(typeof ThreadFollow[fn]).toBe('function');
    }
  });

  it('so does the controller, with its three handlers', () => {
    // eslint-disable-next-line global-require
    const controller = require('../../../controllers/threadFollowController');
    for (const fn of ['followThread', 'unfollowThread', 'listFollowedThreads']) {
      expect(typeof controller[fn]).toBe('function');
    }
  });
});
