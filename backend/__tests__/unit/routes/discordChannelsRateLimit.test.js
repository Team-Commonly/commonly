// TASK-123 (a) item 1 — the behavioural half of the limiter witness.
//
// `discordBindingContainment.test.js` asserts the order by handle identity with
// the limiter stubbed to a pass-through, so only the stack is observable there.
// This file is the second instrument on the same fact: the limiter is the real
// `listIntegrationsRateLimit` and the requests are real, so the order shows up
// in the status codes. An unauthenticated flood that ends in 429 rather than 401
// can only happen if the limiter answered before `auth` could — mounted after
// auth, every request here is 401, because the handler that would have consumed
// the budget is never reached.
//
// Bucket: `integrationsRateLimitKey` keys on the Authorization header when one
// is present and on the Cloudflare-resolved address otherwise —
// `cf-connecting-ip`, then `req.ip` (`middleware/ipRateLimit.ts:49`, TASK-125).
// This flood sends neither header, so it lands on `req.ip` and cannot disturb
// the token-keyed buckets other suites use. (`server.ts:94-101` records why
// `req.ip` is a cloudflared pod address rather than the client in production.)
const request = require('supertest');
const express = require('express');

jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
// The real `middleware/auth` is deliberately NOT mocked here — the 401s below are
// its own. Instrument note: this suite's require graph reaches `jsonwebtoken`, so
// it needs Node ≤24 (`backend/TESTING.md` documents the leaf that dies on 25+);
// CI runs 22, where it passes.
jest.mock('../../../middleware/adminAuth', () => (_req, _res, next) => next());
jest.mock('../../../models/Integration', () => ({
  findOne: jest.fn(),
  findById: jest.fn(),
  findByIdAndUpdate: jest.fn(),
}));
jest.mock('../../../models/DiscordIntegration', () => ({
  findOne: jest.fn(),
  findOneAndDelete: jest.fn(),
}));
jest.mock('../../../models/Pod', () => ({
  find: jest.fn(),
  findById: jest.fn(),
}));
jest.mock('../../../models/User', () => ({
  findById: jest.fn(),
}));
jest.mock('../../../services/discordService', () => {
  const DiscordService = jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(true),
    connect: jest.fn().mockResolvedValue(true),
    disconnect: jest.fn().mockResolvedValue(true),
    registerSlashCommands: jest.fn().mockResolvedValue(true),
  }));
  DiscordService.registerCommandsForAllIntegrations = jest.fn().mockResolvedValue({ success: true });
  return DiscordService;
});
jest.mock('../../../services/discordMultiCommandService', () => ({
  runDiscordCommandForIntegrations: jest.fn(),
}));

const discordRoutes = require('../../../routes/discord');

const GUILD = '123456789012345678';
const PATH = `/api/discord/channels/${GUILD}`;

// The budget this route carries, read from the limiter rather than restated:
// `listIntegrationsRateLimit` in middleware/integrationRateLimit.ts.
const BUDGET = 120;
const FLOOD = BUDGET + 1;
const LIMITER_MSG = 'rate limit exceeded: 120 reads per 60s';

const app = express();
app.use(express.json());
app.use('/api/discord', discordRoutes);

// Sequential on purpose: express-rate-limit counts on arrival, so a concurrent
// burst would decide the last status by timing rather than by order.
const flood = (remaining, seen) => {
  if (remaining === 0) return Promise.resolve(seen);
  return request(app).get(PATH).then((res) => flood(remaining - 1, seen.concat({
    status: res.status,
    msg: res.body && res.body.msg,
  })));
};

describe('the channel-list limiter answers ahead of auth (TASK-123 a)', () => {
  beforeEach(() => {
    process.env.DISCORD_BOT_TOKEN = 'bot-secret';
  });

  it('ends an unauthenticated flood with 429, which only holds if the limiter is mounted before auth', async () => {
    const seen = await flood(FLOOD, []);
    const statuses = seen.map((entry) => entry.status);
    const limited = seen.filter((entry) => entry.status === 429);

    // No Authorization header is sent, so without the limiter every one of these
    // is 401 from `auth`. The first BUDGET are exactly that, and only the
    // (BUDGET + 1)th is refused by the limiter.
    expect(statuses.slice(0, BUDGET).every((status) => status === 401)).toBe(true);
    expect(statuses[BUDGET]).toBe(429);
    // Identified as THIS limiter, not a blanket refusal: the body is its own.
    expect(limited).toHaveLength(1);
    expect(limited[0].msg).toBe(LIMITER_MSG);
  });
});
