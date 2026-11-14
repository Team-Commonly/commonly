// F525: the connect page's one pasted line carries a short-lived connect code,
// not the agent's lasting key, so shell history keeps nothing that still
// works. The CLI trades the code for the key on POST
// /api/agents/runtime/connect-code. Real models: the code row, the agent's
// token record and the audit log are read back from Mongo.
const request = require('supertest');
const express = require('express');
const User = require('../../models/User');
const AgentConnectCode = require('../../models/AgentConnectCode');
const AuditLog = require('../../models/AuditLog');
const { hash } = require('../../utils/secret');
const {
  CONNECT_CODE_TTL_MS, CONNECT_CODE_MAX_REDEEMS, mintConnectCode, redeemConnectCode,
} = require('../../services/agentConnectCodeService');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

describe('agent connect codes', () => {
  let app;
  let seq = 0;

  beforeAll(async () => {
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api/agents/runtime', require('../../routes/agentsRuntime'));
  });
  afterAll(async () => { await closeMongoDb(); });
  afterEach(async () => { await clearMongoDb(); });

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
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(CONNECT_CODE_TTL_MS - 5_000);

    const stored = await AgentConnectCode.find({}).lean();
    expect(stored).toHaveLength(1);
    const dump = JSON.stringify(stored);
    expect(dump).not.toContain(code);
    expect(dump).not.toContain(raw);
    expect(stored[0].codeHash).toBe(hash(code));

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
    await AgentConnectCode.updateOne({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
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
    await AgentConnectCode.updateOne({}, { $set: { agentUserId: two.agent._id } });
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
  });
});
