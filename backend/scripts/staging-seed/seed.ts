/**
 * Staging seed (TASK-697): fills one invite-only pod with real-shaped data for
 * v2 screenshots. Idempotent: every Mongo row is upserted under a fixed
 * ObjectId (fixtures.seedObjectId) with fixed dates, and every Postgres row is
 * looked up by a natural key before it is inserted, so a second run writes
 * nothing. The caller runs the staging guard first (../staging-seed.ts); this
 * module takes its Postgres pool as an argument so tests can hand it pg-mem.
 *
 * Messages go to PostgreSQL only. That is where v2 reads chat from; the Mongo
 * message store is the backend's fallback for a Postgres outage, and a seed
 * that silently fell back would leave the screenshots reading an empty pod.
 */
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Types } from 'mongoose';
import User from '../../models/User';
import Pod from '../../models/Pod';
import Task from '../../models/Task';
import AgentMemory from '../../models/AgentMemory';
import Integration from '../../models/Integration';
import { AgentInstallation } from '../../models/AgentRegistry';
import { assertCredOutOutsideRepo } from './guard';
import { UI_CARD_CATALOGUE, validateAgentCardPayload } from '../../services/uiCardValidation';
import {
  AGENTS, CONNECTED_HOSTED_ENTRY, HUMANS, MEMORIES, MESSAGES, POD, SEAT, SEED_EMAIL_DOMAIN,
  SEED_EPOCH, TASKS, agentUsername, seedObjectId,
} from './fixtures';

export interface PgPoolLike {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface StagingSeedOptions {
  pool: PgPoolLike;
  /** Where the seat password is written (0600) when it is created or rotated. */
  credOut: string;
  rotate?: boolean;
  /** Clock for Postgres message timestamps; defaults to now. */
  now?: () => Date;
}

export interface WriteTally { upserted: number; modified: number }
export interface StagingSeedReport {
  mongo: Record<'users' | 'pods' | 'installations' | 'tasks' | 'memory' | 'connectors', WriteTally>;
  pg: { users: number; pods: number; members: number; messages: number };
  seatPassword: 'created' | 'rotated' | 'unchanged';
  podId: string;
}

const tally = (): WriteTally => ({ upserted: 0, modified: 0 });
const count = (into: WriteTally, write: { upsertedCount?: number; modifiedCount?: number }) => {
  into.upserted += write.upsertedCount || 0;
  into.modified += write.modifiedCount || 0;
};

const idOf = (key: string): Types.ObjectId => seedObjectId(key);
const agentByKey = new Map(AGENTS.map((agent) => [agent.key, agent]));
const humanByKey = new Map([...HUMANS, SEAT].map((human) => [human.key, human]));

/** The label chat renders for an author; mirrors AgentIdentityService.chatUsernameFor. */
const chatName = (key: string): string => agentByKey.get(key)?.displayName || humanByKey.get(key)?.displayName || key;
const usernameOf = (key: string): string => {
  const agent = agentByKey.get(key);
  if (agent) return agentUsername(agent);
  const human = humanByKey.get(key);
  if (!human) throw new Error(`unknown seed author ${key}`);
  return human.username;
};

/** An unusable password: a hash of random bytes nobody keeps. Humans in the sample never log in. */
const unusablePasswordHash = () => bcrypt.hash(randomBytes(32).toString('hex'), 10);

const writeCredFile = (file: string, body: Record<string, unknown>): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  // Exclusive create: a leftover or planted file at the temp path is replaced,
  // never written through (a symlink there would otherwise be followed).
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
};

async function seedUsers(report: StagingSeedReport, options: StagingSeedOptions): Promise<void> {
  const users = report.mongo.users;
  for (const human of HUMANS) {
    count(users, await User.updateOne(
      { _id: idOf(human.key) },
      {
        $set: { username: human.username, displayName: human.displayName, verified: true, role: 'user', isBot: false },
        $setOnInsert: {
          email: `${human.username}@${SEED_EMAIL_DOMAIN}`,
          password: await unusablePasswordHash(),
          createdAt: SEED_EPOCH,
          updatedAt: SEED_EPOCH,
        },
      },
      { upsert: true, timestamps: false },
    ));
  }

  for (const agent of AGENTS) {
    count(users, await User.updateOne(
      { _id: idOf(agent.key) },
      {
        $set: {
          username: agentUsername(agent),
          isBot: true,
          botType: 'agent',
          verified: true,
          role: 'user',
          'botMetadata.displayName': agent.displayName,
          'botMetadata.description': agent.description,
          'botMetadata.agentName': agent.agentName,
          'botMetadata.instanceId': agent.instanceId,
          'botMetadata.runtime': agent.agentName,
          'botMetadata.officialAgent': false,
        },
        $setOnInsert: {
          // The reserved agent address namespace (agentIdentityService.AGENT_ADDRESS_DOMAIN).
          email: `${agentUsername(agent)}@agents.commonly.local`,
          password: await unusablePasswordHash(),
          createdAt: SEED_EPOCH,
          updatedAt: SEED_EPOCH,
        },
      },
      { upsert: true, timestamps: false },
    ));
  }

  // The seat: a real, non-admin login. Its password is generated only when the
  // account is new or --rotate is passed, written to the cred file BEFORE the
  // database (a failed DB write then leaves a stale file, never an account
  // nobody can log into), and never printed.
  const seatId = idOf(SEAT.key);
  const exists = await User.exists({ _id: seatId });
  let passwordHash: string | null = null;
  if (!exists || options.rotate) {
    const password = randomBytes(18).toString('base64url');
    const email = `${SEAT.username}@${SEED_EMAIL_DOMAIN}`;
    writeCredFile(options.credOut, {
      target: 'commonly-staging',
      username: SEAT.username,
      email,
      password,
      writtenAt: new Date().toISOString(),
    });
    passwordHash = await bcrypt.hash(password, 10);
    report.seatPassword = exists ? 'rotated' : 'created';
  }
  count(users, await User.updateOne(
    { _id: seatId },
    {
      $set: {
        username: SEAT.username,
        displayName: SEAT.displayName,
        verified: true,
        role: 'user',
        isBot: false,
        ...(passwordHash ? { password: passwordHash } : {}),
      },
      // A rotation ends every session the old password opened (models/User pre-save does the same).
      ...(passwordHash && exists ? { $inc: { tokenVersion: 1 } } : {}),
      $setOnInsert: { email: `${SEAT.username}@${SEED_EMAIL_DOMAIN}`, createdAt: SEED_EPOCH, updatedAt: SEED_EPOCH },
    },
    { upsert: true, timestamps: false },
  ));
}

async function seedPod(report: StagingSeedReport): Promise<Types.ObjectId[]> {
  const podId = idOf(POD.key);
  const creator = idOf(HUMANS[0].key);
  // The seat installs the agents, so its owner-only views (agent settings,
  // Your Team) have something to show.
  const installer = idOf(SEAT.key);
  const members = [...HUMANS.map((h) => idOf(h.key)), idOf(SEAT.key), ...AGENTS.map((a) => idOf(a.key))];
  count(report.mongo.pods, await Pod.updateOne(
    { _id: podId },
    {
      $set: {
        name: POD.name,
        description: POD.description,
        type: 'team',
        joinPolicy: 'invite-only',
        publicRead: false,
        communityListed: false,
        createdBy: creator,
      },
      // $addToSet, not $set: people who joined through the UI survive a re-run.
      $addToSet: { members: { $each: members } },
      $setOnInsert: { createdAt: SEED_EPOCH, updatedAt: SEED_EPOCH },
    },
    { upsert: true, timestamps: false },
  ));

  for (const agent of AGENTS) {
    count(report.mongo.installations, await AgentInstallation.updateOne(
      { agentName: agent.agentName, podId, instanceId: agent.instanceId },
      {
        $set: {
          displayName: agent.displayName,
          version: '1.0.0',
          status: 'active',
          installedBy: installer,
          scopes: [],
          // BYO identity: the seat's own machine would run it; nothing is provisioned.
          'config.runtime': { runtimeType: agent.agentName, host: 'byo' },
        },
        $setOnInsert: { _id: idOf(`install:${agent.key}`), createdAt: SEED_EPOCH, updatedAt: SEED_EPOCH },
      },
      { upsert: true, timestamps: false },
    ));
  }
  return members;
}

async function seedTasks(report: StagingSeedReport): Promise<void> {
  const podId = idOf(POD.key);
  for (const [index, task] of TASKS.entries()) {
    const assigneeId = idOf(task.assignee);
    const claimed = task.status === 'claimed';
    const done = task.status === 'done';
    count(report.mongo.tasks, await Task.updateOne(
      { podId, taskId: task.taskId },
      {
        $set: {
          taskNum: index + 1,
          title: task.title,
          priority: task.priority,
          status: task.status,
          // The board resolves an assignee against pod member usernames.
          assignee: usernameOf(task.assignee),
          dep: task.dep || null,
          // The board resolves a holder by member id. BOTH lease timestamps are
          // null on purpose: with claimExpiresAt null the lease is derived as
          // claimedAt + 30 min (tasksApi deriveLeaseState, kernelWorkSweepService
          // lapsedConditions), so a fixed past claimedAt lapses at once and the
          // sweep hands the row back to pending. A claim with neither timestamp
          // reads `held`, and the board shows "claimed by" with no countdown
          // (a far-future expiry would render a countdown of millions of minutes).
          claimedBy: claimed ? String(assigneeId) : null,
          ...(claimed ? { claimedByUserId: String(assigneeId) } : {}),
          claimedAt: null,
          claimExpiresAt: null,
          completedAt: done ? SEED_EPOCH : null,
          prUrl: task.prUrl || null,
          notes: task.notes || null,
          source: 'human',
          // Fixed _id: an auto-generated one would make every re-run a write.
          updates: [{
            _id: idOf(`task-update:${task.taskId}`),
            text: `${chatName(task.assignee)} ${done ? 'finished this' : claimed ? 'claimed this' : 'was assigned this'}`,
            author: chatName(task.assignee),
            authorId: String(assigneeId),
            createdAt: SEED_EPOCH,
          }],
        },
        $setOnInsert: { _id: idOf(`task:${task.taskId}`), createdAt: SEED_EPOCH, updatedAt: SEED_EPOCH },
      },
      { upsert: true, timestamps: false },
    ));
  }
}

async function seedMemory(report: StagingSeedReport): Promise<void> {
  for (const memory of MEMORIES) {
    const agent = agentByKey.get(memory.agentKey)!;
    const section = (content: string) => ({
      content, visibility: 'private', updatedAt: SEED_EPOCH, byteSize: Buffer.byteLength(content, 'utf8'),
    });
    // $setOnInsert: memory belongs to the agent once written; a re-run must not
    // overwrite what an agent later saved there.
    count(report.mongo.memory, await AgentMemory.updateOne(
      { agentName: agent.agentName, instanceId: agent.instanceId },
      {
        $setOnInsert: {
          _id: idOf(`memory:${agent.key}`),
          content: `${memory.soul}\n\n${memory.longTerm}`,
          sections: { soul: section(memory.soul), long_term: section(memory.longTerm) },
          schemaVersion: 2,
          createdAt: SEED_EPOCH,
          updatedAt: SEED_EPOCH,
        },
      },
      { upsert: true, timestamps: false },
    ));
  }
}

async function seedConnectors(report: StagingSeedReport): Promise<void> {
  // Connected, with no usable credential: no credentialRef/refreshTokenRef is
  // written, so a tool call resolves no token and asks to reconnect. The
  // available entry needs no row — the catalogue offers it to anyone.
  count(report.mongo.connectors, await Integration.updateOne(
    { type: 'hosted-mcp', createdBy: idOf(SEAT.key), 'config.entryId': CONNECTED_HOSTED_ENTRY },
    {
      $set: {
        scope: 'user',
        status: 'connected',
        isActive: true,
        'config.intake': 'oauth',
        'config.credentialHint': 'staging seed sample (no credential)',
      },
      $setOnInsert: { _id: idOf(`connector:${CONNECTED_HOSTED_ENTRY}`), createdAt: SEED_EPOCH, updatedAt: SEED_EPOCH },
    },
    { upsert: true, timestamps: false },
  ));
}

async function seedPostgres(report: StagingSeedReport, options: StagingSeedOptions, members: Types.ObjectId[]): Promise<void> {
  const { pool } = options;
  const podId = String(idOf(POD.key));
  const creator = String(idOf(HUMANS[0].key));

  // Look-then-insert rather than reading RETURNING off `ON CONFLICT DO NOTHING`:
  // pg-mem returns the conflicting row there, so the tally would lie in tests.
  // ON CONFLICT stays as the backstop for a concurrent writer.
  const insertIfAbsent = async (exists: [string, unknown[]], insert: [string, unknown[]]): Promise<number> => {
    if ((await pool.query(exists[0], exists[1])).rows.length) return 0;
    await pool.query(insert[0], insert[1]);
    return 1;
  };

  const authors = [...HUMANS, SEAT].map((h) => ({ key: h.key, isBot: false }))
    .concat(AGENTS.map((a) => ({ key: a.key, isBot: true })));
  for (const author of authors) {
    const id = String(idOf(author.key));
    report.pg.users += await insertIfAbsent(
      ['SELECT 1 FROM users WHERE _id = $1', [id]],
      [`INSERT INTO users (_id, username, profile_picture, is_bot) VALUES ($1, $2, 'default', $3)
        ON CONFLICT (_id) DO NOTHING`, [id, chatName(author.key), author.isBot]],
    );
  }

  report.pg.pods += await insertIfAbsent(
    ['SELECT 1 FROM pods WHERE id = $1', [podId]],
    [`INSERT INTO pods (id, name, description, type, created_by) VALUES ($1, $2, $3, 'team', $4)
      ON CONFLICT (id) DO NOTHING`, [podId, POD.name, POD.description, creator]],
  );
  for (const member of members) {
    report.pg.members += await insertIfAbsent(
      ['SELECT 1 FROM pod_members WHERE pod_id = $1 AND user_id = $2', [podId, String(member)]],
      [`INSERT INTO pod_members (pod_id, user_id) VALUES ($1, $2)
        ON CONFLICT (pod_id, user_id) DO NOTHING`, [podId, String(member)]],
    );
  }

  // Messages have no seed column, so the natural key is (pod, author, content);
  // every seeded content string is unique. A message that is missing (first run,
  // or removed by retention since) is inserted at its slot relative to now.
  const now = (options.now || (() => new Date()))().getTime();
  const ids = new Map<string, unknown>();
  for (const [index, message] of MESSAGES.entries()) {
    const userId = String(idOf(message.author));
    const existing = await pool.query(
      'SELECT id FROM messages WHERE pod_id = $1 AND user_id = $2 AND content = $3 LIMIT 1',
      [podId, userId, message.content],
    );
    if (existing.rows[0]) {
      ids.set(message.key, existing.rows[0].id);
      continue;
    }
    let payload = message.payload || null;
    if (message.messageType === 'card') {
      payload = { ...message.payload, ...UI_CARD_CATALOGUE };
      validateAgentCardPayload('card', payload, message.content);
    }
    const threadRootId = message.threadOf ? ids.get(message.threadOf) : null;
    if (message.threadOf && threadRootId == null) throw new Error(`thread root ${message.threadOf} was not written`);
    const createdAt = new Date(now - (MESSAGES.length - index) * 60_000);
    const { rows } = await pool.query(
      `INSERT INTO messages (pod_id, user_id, content, message_type, payload, thread_root_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::int, $7, $7) RETURNING id`,
      [podId, userId, message.content, message.messageType,
        payload == null ? null : JSON.stringify(payload), threadRootId ?? null, createdAt],
    );
    ids.set(message.key, rows[0].id);
    report.pg.messages += 1;
  }
}

export async function runStagingSeed(options: StagingSeedOptions): Promise<StagingSeedReport> {
  assertCredOutOutsideRepo(options.credOut);
  const report: StagingSeedReport = {
    mongo: {
      users: tally(), pods: tally(), installations: tally(), tasks: tally(), memory: tally(), connectors: tally(),
    },
    pg: { users: 0, pods: 0, members: 0, messages: 0 },
    seatPassword: 'unchanged',
    podId: String(idOf(POD.key)),
  };
  await seedUsers(report, options);
  const members = await seedPod(report);
  await seedTasks(report);
  await seedMemory(report);
  await seedConnectors(report);
  await seedPostgres(report, options, members);
  return report;
}
