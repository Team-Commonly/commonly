// F525: the connect page's one pasted line carries a short-lived connect code,
// not the agent's lasting key, so shell history keeps nothing that still
// works. The CLI trades the code for the key on POST
// /api/agents/runtime/connect-code. The agent's token record and the audit log
// are real Mongo; the codes are a Postgres table (ADR-034 D4), built from the
// shipped migration on pg-mem.
jest.mock('../../config/db-pg', () => {
  // eslint-disable-next-line global-require
  const { newDb } = require('pg-mem');
  const { Pool } = newDb().adapters.createPg();
  return { pool: new Pool() };
});

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const express = require('express');
const { pool } = require('../../config/db-pg');
const User = require('../../models/User');
const AuditLog = require('../../models/AuditLog');
const { hash } = require('../../utils/secret');
const {
  CONNECT_CODE_TTL_MS, CONNECT_CODE_MAX_REDEEMS, mintConnectCode, redeemConnectCode,
} = require('../../services/agentConnectCodeService');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

describe('agent connect codes', () => {
  let app;
  let seq = 0;

  const MIGRATION = fs.readFileSync(path.join(__dirname, '../../config/migrations/0015_agent_connect_codes.sql'), 'utf8');
  const storedCodes = async () => (await pool.query('SELECT * FROM agent_connect_codes')).rows;

  beforeAll(async () => {
    await setupMongoDb();
    await pool.query(MIGRATION);
    app = express();
    app.use(express.json());
    // eslint-disable-next-line global-require
    app.use('/api/agents/runtime', require('../../routes/agentsRuntime'));
  });
  afterAll(async () => { await closeMongoDb(); });
  afterEach(async () => {
    await clearMongoDb();
    await pool.query('DELETE FROM agent_connect_codes');
  });

  const agentWithToken = async () => {
    seq += 1;
    const raw = `cm_agent_${String(seq).padStart(4, '0')}${'b'.repeat(60)}`;
    const agent = await User.create({
      username: `connect-code-${seq}`,
      email: `connect-code-${seq}@agents.example.com`,
      password: 'unused',
      isBot: true,
      botMetadata: { agentName: 'claude', instanceId: 'default' },
      agentRuntimeTokens: [{ tokenHash: hash(raw), label: 'Provisioned default', createdAt: new Date() }],
    });
    return { agent, raw };
  };
  const redeem = (code) => request(app).post('/api/agents/runtime/connect-code').send({ code });

  it('trades a fresh code for the key, and stores neither in the clear', async () => {
    const { agent, raw } = await agentWithToken();
    const { code, expiresAt } = await mintConnectCode({ agentUserId: agent._id, rawToken: raw });
    expect(code).toMatch(/^cmc_[A-Za-z0-9_-]{22}$/);
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(CONNECT_CODE_TTL_MS - 5000);

    const stored = await storedCodes();
    expect(stored).toHaveLength(1);
    const dump = JSON.stringify(stored);
    expect(dump).not.toContain(code);
    expect(dump).not.toContain(raw);
    expect(stored[0].code_hash).toBe(hash(code));
    expect(stored[0].agent_user_id).toBe(String(agent._id));

    const response = await redeem(code);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ token: raw });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('works again before the agent listens, so a retry after a preflight stop still connects', async () => {
    const { agent, raw } = await agentWithToken();
    const { code } = await mintConnectCode({ agentUserId: agent._id, rawToken: raw });
    expect((await redeem(code)).status).toBe(200);
    expect((await redeem(code)).body).toEqual({ token: raw });
  });

  it('is spent once the agent has listened', async () => {
    const { agent, raw } = await agentWithToken();
    const { code } = await mintConnectCode({ agentUserId: agent._id, rawToken: raw });
    await User.updateOne({ _id: agent._id }, { $set: { 'agentRuntimeTokens.0.lastListenedAt': new Date() } });
    const response = await redeem(code);
    expect(response.status).toBe(410);
    expect(response.body).toEqual({ code: 'connect_code_used' });
    expect(response.body.token).toBeUndefined();
  });

  it('is refused once its key is revoked', async () => {
    const { agent, raw } = await agentWithToken();
    const { code } = await mintConnectCode({ agentUserId: agent._id, rawToken: raw });
    await User.updateOne({ _id: agent._id }, { $set: { agentRuntimeTokens: [] } });
    const response = await redeem(code);
    expect(response.status).toBe(410);
    expect(response.body).toEqual({ code: 'connect_code_revoked' });
  });

  it('is refused after its window', async () => {
    const { agent, raw } = await agentWithToken();
    const { code } = await mintConnectCode({ agentUserId: agent._id, rawToken: raw });
    await pool.query('UPDATE agent_connect_codes SET expires_at = $1', [new Date(Date.now() - 1000)]);
    const response = await redeem(code);
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ code: 'connect_code_unknown' });
  });

  it('refuses an unknown code and a malformed body', async () => {
    expect((await redeem(`cmc_${'x'.repeat(22)}`)).status).toBe(404);
    expect((await redeem('cm_agent_abc')).status).toBe(400);
    expect((await request(app).post('/api/agents/runtime/connect-code').send({ code: `cmc_${'x'.repeat(22)}`, extra: 1 })).status).toBe(400);
  });

  it('caps redeems per code, so one agent cannot be hammered through it', async () => {
    const { agent, raw } = await agentWithToken();
    const { code } = await mintConnectCode({ agentUserId: agent._id, rawToken: raw });
    for (let i = 0; i < CONNECT_CODE_MAX_REDEEMS; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect((await redeemConnectCode(code)).token).toBe(raw);
    }
    const response = await redeem(code);
    expect(response.status).toBe(429);
    expect(response.body).toEqual({ code: 'connect_code_rate_limited' });
  });

  it('records every redeem by agent and outcome, never the code', async () => {
    const { agent, raw } = await agentWithToken();
    const { code } = await mintConnectCode({ agentUserId: agent._id, rawToken: raw });
    await redeem(code);
    await redeem(`cmc_${'y'.repeat(22)}`);
    const rows = await AuditLog.find({ action: 'agent_connect_code_redeem' }).sort({ createdAt: 1 }).lean();
    expect(rows.map((row) => [row.target, row.detail])).toEqual([
      [String(agent._id), 'redeemed'],
      [null, 'unknown'],
    ]);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(code);
    expect(dump).not.toContain(raw);
  });

  it('a sealed key moved onto another agent\'s row does not open', async () => {
    const one = await agentWithToken();
    const two = await agentWithToken();
    const { code } = await mintConnectCode({ agentUserId: one.agent._id, rawToken: one.raw });
    await pool.query('UPDATE agent_connect_codes SET agent_user_id = $1', [String(two.agent._id)]);
    await User.updateOne({ _id: two.agent._id }, { $set: { 'agentRuntimeTokens.0.tokenHash': hash(one.raw) } });
    const response = await redeem(code);
    expect(response.status).toBe(503);
    expect(response.body.token).toBeUndefined();
  });

  it('limits redeems per IP', async () => {
    const from = (n) => request(app).post('/api/agents/runtime/connect-code')
      .set('cf-connecting-ip', '203.0.113.9').send({ code: `cmc_${String(n).padStart(22, 'z')}` });
    for (let i = 0; i < 30; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect((await from(i)).status).toBe(404);
    }
    const response = await from(31);
    expect(response.status).toBe(429);
    expect(response.body).toEqual({ code: 'connect_code_rate_limited' });
  });

  it('a new code replaces the agent\'s older one', async () => {
    const { agent, raw } = await agentWithToken();
    const first = await mintConnectCode({ agentUserId: agent._id, rawToken: raw });
    const second = await mintConnectCode({ agentUserId: agent._id, rawToken: raw });
    expect((await redeem(first.code)).status).toBe(404);
    expect((await redeem(second.code)).status).toBe(200);
    expect(await storedCodes()).toHaveLength(1);
  });

  it('mints at once for one agent still leave one live code, and it starts its own redeem count', async () => {
    const { agent, raw } = await agentWithToken();
    const first = await mintConnectCode({ agentUserId: agent._id, rawToken: raw });
    await redeem(first.code);
    const minted = await Promise.all(Array.from({ length: 5 }, () => mintConnectCode({ agentUserId: agent._id, rawToken: raw })));
    const rows = await storedCodes();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].redeems)).toBe(0);
    expect(minted.map(({ code }) => hash(code))).toContain(rows[0].code_hash);
  });

  it('a mint clears other agents\' expired codes, and leaves their live ones', async () => {
    const one = await agentWithToken();
    const two = await agentWithToken();
    const three = await agentWithToken();
    await mintConnectCode({ agentUserId: one.agent._id, rawToken: one.raw });
    await pool.query('UPDATE agent_connect_codes SET expires_at = $1', [new Date(Date.now() - 1000)]);
    const live = await mintConnectCode({ agentUserId: two.agent._id, rawToken: two.raw });
    await mintConnectCode({ agentUserId: three.agent._id, rawToken: three.raw });
    const owners = (await storedCodes()).map((row) => row.agent_user_id).sort();
    expect(owners).toEqual([String(two.agent._id), String(three.agent._id)].sort());
    expect((await redeem(live.code)).status).toBe(200);
  });

  it('without PostgreSQL answers 503 on redeem, and a mint throws so the route returns the key alone', async () => {
    // The repository reads the pool on each call, as db-pg leaves it null without PG_HOST.
    // eslint-disable-next-line global-require
    const dbPg = require('../../config/db-pg');
    dbPg.pool = null;
    try {
      const response = await redeem(`cmc_${'q'.repeat(22)}`);
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ code: 'connect_code_unavailable' });
      await expect(mintConnectCode({ agentUserId: 'a'.repeat(24), rawToken: 'cm_agent_x' }))
        .rejects.toMatchObject({ code: 'connect_code_unavailable' });
    } finally {
      dbPg.pool = pool;
    }
  });
});
