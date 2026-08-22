/**
 * Per-user, per-thread state (W-T, TASK-029, 2/4).
 *
 * The decisions worth pinning are about SHAPE, not SQL mechanics:
 *  - a separate record, not a widened User.followedThreads
 *  - ONE record carrying both booleans, per the threading surface ruling
 *  - `following` is tri-state; NOT NULL DEFAULT false would be a live bug
 *  - `collapsed` defaults true for everyone; following never implies expanded
 *  - the two are written by separate endpoints, never one combined PATCH
 */
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '../../../', p), 'utf8');
const MODEL = read('models/pg/ThreadUserState.ts');
const CONTROLLER = read('controllers/threadStateController.ts');
const ROUTES = read('routes/messages.ts');
const SCHEMA = read('config/schema.sql');
const USER = read('models/User.ts');

const TABLE = SCHEMA.slice(
  SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS thread_user_state'),
  SCHEMA.indexOf('idx_thread_user_state_root'),
);

describe('a separate record, not a widened followedThreads', () => {
  it('User.followedThreads is still typed to Post and untouched', () => {
    // The whole reason for a new table. If someone later widens this to accept
    // a message id, every Post.find({_id: {$in: postIds}}) consumer silently
    // drops the chat rows.
    expect(USER).toMatch(/postId:\s*\{\s*type:\s*Schema\.Types\.ObjectId,\s*ref:\s*'Post',\s*required:\s*true\s*\}/);
  });

  it('thread_user_state references messages(id), which followedThreads cannot', () => {
    expect(TABLE).toMatch(/thread_root_id INTEGER NOT NULL REFERENCES messages\(id\) ON DELETE CASCADE/);
  });
});

describe('one record, two booleans', () => {
  it('both live on the same table under the same key', () => {
    expect(TABLE).toMatch(/following BOOLEAN/);
    expect(TABLE).toMatch(/collapsed BOOLEAN NOT NULL DEFAULT TRUE/);
    expect(TABLE).toMatch(/UNIQUE \(thread_root_id, user_id\)/);
  });

  it('there is no second table on the identical key', () => {
    // The failure mode the ruling exists to prevent: 4/4 adding
    // thread_collapse_state alongside this one.
    expect(SCHEMA).not.toMatch(/CREATE TABLE IF NOT EXISTS thread_collapse/);
    expect(SCHEMA).not.toMatch(/CREATE TABLE IF NOT EXISTS thread_follows/);
  });

  it('the unique is (root, user) — many users hold state on one thread', () => {
    expect(TABLE).not.toMatch(/UNIQUE \(thread_root_id\)\s/);
  });
});

describe('following is tri-state, and that is load-bearing', () => {
  it('the column is nullable — NULL means "defer to participation"', () => {
    // NOT NULL DEFAULT false would be a live bug: a collapse-only row would
    // silently unfollow a participant who never touched the toggle.
    expect(TABLE).toMatch(/\n  following BOOLEAN,/);
    expect(TABLE).not.toMatch(/following BOOLEAN NOT NULL/);
  });

  it('the schema says why, next to the column', () => {
    expect(TABLE).toMatch(/would silently unfollow a participant/);
  });

  it('unfollow writes FALSE rather than deleting the row', () => {
    // Deleting would mean "no explicit choice", which for a participant
    // re-subscribes them on the next reply — and would discard collapse state.
    expect(MODEL).toMatch(/static async unfollow[\s\S]{0,200}upsertOne\('following',[^)]*false\)/);
    expect(MODEL).not.toMatch(/DELETE FROM thread_user_state/);
  });

  it('reads distinguish explicit followers from explicit mutes', () => {
    expect(MODEL).toMatch(/following IS TRUE/);
    expect(MODEL).toMatch(/following IS FALSE/);
    // and never conflate NULL with either
    expect(MODEL).not.toMatch(/following\s*=\s*(true|false)\b/);
  });

  it('explicitFollowerIds is named for what it omits', () => {
    // It does NOT include participation-default followers; 3/4 owns that join.
    // A name of `followerIds` would have made under-notification look correct.
    expect(MODEL).toMatch(/static async explicitFollowerIds/);
    expect(MODEL).not.toMatch(/static async followerIds/);
  });
});

describe('following never implies expanded', () => {
  it('collapsed defaults true for everyone, including followers', () => {
    expect(TABLE).toMatch(/collapsed BOOLEAN NOT NULL DEFAULT TRUE/);
  });

  it('each writer touches exactly one column', () => {
    // upsertOne is the single write path and takes the column as an argument,
    // so a follow cannot re-collapse and an expand cannot subscribe.
    expect(MODEL).toMatch(/function upsertOne\(\s*column: 'following' \| 'collapsed'/);
    expect(MODEL).toMatch(/upsertOne\('collapsed'/);
    expect(MODEL).toMatch(/upsertOne\('following'/);
  });

  it('follow and collapse are separate endpoints, not one combined PATCH', () => {
    expect(ROUTES).toMatch(/router\.post\('\/:messageId\/follow'/);
    expect(ROUTES).toMatch(/router\.delete\('\/:messageId\/follow'/);
    expect(ROUTES).toMatch(/router\.put\('\/:messageId\/collapsed'/);
    // No endpoint accepts both booleans in one body.
    expect(CONTROLLER).not.toMatch(/following.*collapsed.*req\.body|req\.body[\s\S]{0,80}following/);
  });

  it('the collapse endpoint rejects a missing or non-boolean value', () => {
    // Not defaulted: absence is the caller's bug, and coercing it would let a
    // malformed client silently collapse threads.
    expect(CONTROLLER).toMatch(/typeof collapsedRaw !== 'boolean'/);
  });
});

describe('routes are dualAuth, so agents are not excluded', () => {
  it('all four thread-state routes accept an agent runtime token', () => {
    const lines = ROUTES.split('\n').filter((l) => /threads\/state|\/follow'|\/collapsed'/.test(l) && l.startsWith('router.'));
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(line).toMatch(/dualAuth/);
  });

  it('and the rate limiter precedes auth on every one of them', () => {
    // Ordering rule in routes/messages.ts: the limiter must cover the Mongo
    // lookup auth performs.
    const lines = ROUTES.split('\n').filter((l) => /threads\/state|\/follow'|\/collapsed'/.test(l) && l.startsWith('router.'));
    for (const line of lines) {
      expect(line.indexOf('reactionRateLimit')).toBeLessThan(line.indexOf('dualAuth'));
    }
  });
});

describe('the pod comes from the message, never the client', () => {
  it('resolveRoot reads pod_id alongside the root', () => {
    expect(CONTROLLER).toMatch(/SELECT COALESCE\(thread_root_id, id\) AS root_id, pod_id FROM messages WHERE id = \$1/);
  });
});

describe('the modules actually load', () => {
  // Not ceremony. Every other assertion here reads source TEXT, which is blind
  // to a bad require path — the first draft of this model required
  // '../../config/postgres', a file that does not exist, and every text
  // assertion still passed. One real require is the cheapest control for the
  // failure mode the rest of the suite shares.
  it('the model exposes its statics when required for real', () => {
    // eslint-disable-next-line global-require
    const M = require('../../../models/pg/ThreadUserState');
    for (const fn of ['follow', 'unfollow', 'clearFollowChoice', 'setCollapsed',
      'explicitFollowerIds', 'mutedUserIds', 'stateForPod']) {
      expect(typeof M[fn]).toBe('function');
    }
  });

  it('the controller exposes its four handlers', () => {
    // eslint-disable-next-line global-require
    const c = require('../../../controllers/threadStateController');
    for (const fn of ['followThread', 'unfollowThread', 'listThreadState', 'setThreadCollapsed']) {
      expect(typeof c[fn]).toBe('function');
    }
  });
});

describe('the pre-cutoff expanded default reaches the client', () => {
  // @sprint-review (56862): #1115 says pre-cutoff roots default to EXPANDED,
  // which changes what an absent row means — and the shipped contract
  // ("caller applies collapsed true") could not express it. 4/4 would have
  // discovered that while wiring the component.
  const CONTROLLER_SRC = read('controllers/threadStateController.ts');

  it('the response carries the cutoff, not just a boolean default', () => {
    expect(CONTROLLER_SRC).toMatch(/expandedForRootsCreatedBefore: threadingCutoff/);
  });

  it('it is read from the migration ledger, by the backfill\'s own name', () => {
    // Not a hardcoded date, and not a second definition of the name.
    expect(CONTROLLER_SRC).toMatch(/require\('\.\.\/scripts\/backfill-thread-root-id'\)/);
    expect(CONTROLLER_SRC).toMatch(/FROM migration_records WHERE name = \$1/);
    expect(CONTROLLER_SRC).not.toMatch(/threadingCutoff = '20\d\d-/);
  });

  it('one timestamp, not a per-thread resolution', () => {
    // Resolving server-side would enumerate every root and join
    // messages.created_at — data the client already has, since it is
    // rendering those messages.
    expect(CONTROLLER_SRC).not.toMatch(/JOIN messages[\s\S]{0,80}created_at[\s\S]{0,80}thread_user_state/);
    expect(CONTROLLER_SRC).toMatch(/Promise\.all\(\[/);
  });

  it('a missing ledger row degrades to null rather than failing the read', () => {
    // A cosmetic default must never take the render path down.
    expect(CONTROLLER_SRC).toMatch(/} catch {\s*return null;/);
  });

  it('null is documented as "no pre-cutoff roots", never as "unknown"', () => {
    // The dangerous misreading would expand every thread on a fresh instance.
    expect(CONTROLLER_SRC).toMatch(/NOT "unknown"/);
  });
});
