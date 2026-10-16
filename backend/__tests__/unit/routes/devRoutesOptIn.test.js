/**
 * Dev tooling routes exist only with COMMONLY_ENABLE_DEV_ROUTES=true, never
 * because of NODE_ENV (a deployed instance can run NODE_ENV=development).
 * These arms run the shipped routers.
 */
const express = require('express');
const request = require('supertest');

jest.mock('../../../middleware/auth', () => (req, _res, next) => {
  req.userId = 'user-1';
  req.user = { id: 'user-1' };
  next();
});
jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(() => ({ lean: () => Promise.resolve({ _id: 'pod-1', members: ['user-1'] }) })),
}));
jest.mock('../../../services/agentEventService', () => ({
  enqueue: jest.fn().mockResolvedValue({ _id: 'evt-1' }),
}));
jest.mock('../../../services/vectorSearchService', () => ({ EMBEDDING_CONFIG: {} }));

const AgentEventService = require('../../../services/agentEventService');
const devRoutes = require('../../../routes/dev');
const testBotRoutes = require('../../../routes/test-bot');

const app = express();
app.use(express.json());
app.use('/api/dev', devRoutes);
app.use('/api/test/bot', testBotRoutes);

const devEvent = {
  podId: 'pod-1',
  agentName: 'analyst',
  type: 'chat.mention',
  payload: { messageId: '1', content: 'hello' },
};
const calls = () => [
  request(app).post('/api/dev/agents/events').send(devEvent),
  request(app).get('/api/dev/llm/status'),
  request(app).post('/api/test/bot/discord-summary').send({ podId: 'pod-1', discordSummary: 'x' }),
];

describe('dev tooling routes are opt-in', () => {
  const saved = { flag: process.env.COMMONLY_ENABLE_DEV_ROUTES, nodeEnv: process.env.NODE_ENV };
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.COMMONLY_ENABLE_DEV_ROUTES;
  });
  afterAll(() => {
    if (saved.flag === undefined) delete process.env.COMMONLY_ENABLE_DEV_ROUTES;
    else process.env.COMMONLY_ENABLE_DEV_ROUTES = saved.flag;
    process.env.NODE_ENV = saved.nodeEnv;
  });

  test('without the flag every route is absent and nothing is queued', async () => {
    for (const res of await Promise.all(calls())) expect(res.status).toBe(404);
    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
  });

  test('NODE_ENV=development does not open them', async () => {
    process.env.NODE_ENV = 'development';
    try {
      for (const res of await Promise.all(calls())) expect(res.status).toBe(404);
    } finally {
      process.env.NODE_ENV = saved.nodeEnv;
    }
    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
  });

  test.each(['1', 'TRUE', 'yes', ''])('a flag of %p is not the opt-in', async (value) => {
    process.env.COMMONLY_ENABLE_DEV_ROUTES = value;
    for (const res of await Promise.all(calls())) expect(res.status).toBe(404);
    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
  });

  test('CONTROL: with the flag the routes run, so the 404s above are the gate', async () => {
    process.env.COMMONLY_ENABLE_DEV_ROUTES = 'true';
    const [events, , discord] = await Promise.all(calls());
    expect(events.status).toBe(200);
    expect(discord.status).toBe(200);
    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(2);
  });
});

describe('server.ts mounts them only under the flag', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../../../server.ts'), 'utf8');
  const gate = src.indexOf("if (require('./config/devRoutes').devRoutesEnabled()) {");
  const block = gate === -1 ? '' : src.slice(gate, src.indexOf('\n}\n', gate));

  test('both mounts sit inside the opt-in block, and nowhere else', () => {
    expect(gate).toBeGreaterThan(-1);
    expect(block).toContain("app.use('/api/dev', devRoutes)");
    expect(block).toContain("app.use('/api/test/bot', testBotRoutes)");
    expect(src.split("app.use('/api/dev'")).toHaveLength(2);
    expect(src.split("app.use('/api/test/bot'")).toHaveLength(2);
  });

  test('no dev mount is gated on NODE_ENV', () => {
    expect(src).not.toMatch(/NODE_ENV === 'development'\)\s*\{[^}]*app\.use\('\/api\/(dev|test)/);
  });
});

describe('only the dev compose file opts in', () => {
  const read = (name) => require('fs').readFileSync(require('path').join(__dirname, '../../../../', name), 'utf8');
  const setsFlag = (text) => /^\s*-?\s*COMMONLY_ENABLE_DEV_ROUTES\s*[:=]\s*["']?true/m.test(text);

  test('docker-compose.dev.yml (dev.sh) sets it', () => {
    expect(setsFlag(read('docker-compose.dev.yml'))).toBe(true);
  });

  test.each(['docker-compose.yml', 'docker-compose.local.yml'])('%s (a deployment path) never does', (name) => {
    expect(read(name)).not.toMatch(/COMMONLY_ENABLE_DEV_ROUTES/);
  });

  test('the scripts still read the files this assumes', () => {
    expect(read('dev.sh')).toMatch(/COMPOSE_FILE="docker-compose\.dev\.yml"/);
    expect(read('prod.sh')).toMatch(/COMPOSE_FILE="docker-compose\.yml"/);
  });
});
