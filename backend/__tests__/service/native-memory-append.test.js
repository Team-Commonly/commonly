const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const { execFileSync } = require('child_process');
const path = require('path');
const { pathToFileURL } = require('url');

jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('../../models/Pod', () => ({
  findById: jest.fn(() => ({ lean: async () => ({ name: 'Memory handoff' }) })),
}));
jest.mock('../../models/User', () => ({
  findOne: jest.fn(() => ({ select: () => ({ lean: async () => null }) })),
  findById: jest.fn(() => ({ select: () => ({ lean: async () => ({ isBot: false }) }) })),
}));
jest.mock('../../models/pg/Message', () => ({ findByPodId: jest.fn().mockResolvedValue([]) }));
jest.mock('../../services/agentTypingService', () => ({
  emitAgentTypingStart: jest.fn(), emitAgentTypingStop: jest.fn(),
}));
jest.mock('../../services/agentMessageService', () => ({
  postMessage: jest.fn().mockResolvedValue({ success: true }),
}));
jest.mock('../../services/messageClaimService', () => ({
  claim: jest.fn().mockResolvedValue({ claimed: true }),
  release: jest.fn().mockResolvedValue({ released: true }),
}));
jest.mock('../../services/nativeOutsiderGrantPolicy', () => ({
  podHasOutsiderWritableGrant: jest.fn().mockResolvedValue(false),
}));

const AgentMemory = require('../../models/AgentMemory');
const { appendLongTermMemory } = require('../../services/agentMemoryService');
jest.mock('../../services/agentComputerBroker', () => ({
  agentComputerBroker: {},
  agentComputerEnabled: false,
}));
const { dispatchTool, runAgent } = require('../../services/nativeRuntimeService');
const { GivenAddresses } = require('../../services/webAddressProvenance');
const axios = require('axios').default;

jest.setTimeout(60000);

describe('native long-term memory appends', () => {
  beforeAll(async () => {
    await setupMongoDb();
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  beforeEach(async () => {
    await AgentMemory.deleteMany({});
  });

  it('hands a hosted atomic write from real Mongo to the actual CLI memory reader', async () => {
    const previous = {
      LITELLM_BASE_URL: process.env.LITELLM_BASE_URL,
      LITELLM_MASTER_KEY: process.env.LITELLM_MASTER_KEY,
      HOSTED_TURNS_PER_DAY: process.env.HOSTED_TURNS_PER_DAY,
    };
    process.env.LITELLM_BASE_URL = 'http://litellm.test';
    process.env.LITELLM_MASTER_KEY = 'test-only';
    delete process.env.HOSTED_TURNS_PER_DAY;
    try {
      await AgentMemory.create({
        agentName: 'hosted-handoff', instanceId: 'default', content: 'legacy seed',
      });
      axios.post.mockReset()
        .mockResolvedValueOnce({ data: {
          choices: [{ message: { role: 'assistant', content: null, tool_calls: [{
            id: 'memory-write', type: 'function', function: {
              name: 'commonly_write_memory', arguments: JSON.stringify({ content: 'hosted handoff marker' }),
            },
          }] } }],
        } })
        .mockResolvedValueOnce({ data: {
          choices: [{ message: { role: 'assistant', content: 'Saved.' } }],
        } });
      const result = await runAgent({
        podId: '507f1f77bcf86cd799439011', agentName: 'hosted-handoff', instanceId: 'default',
        installedBy: '507f1f77bcf86cd799439099', displayName: 'Hosted handoff',
        config: { runtime: { runtimeType: 'hosted' }, hosted: { engine: 'native', provisionedAt: new Date() } },
      }, { type: 'chat.mention', payload: { content: 'Remember the handoff marker.' } });
      expect(result).toEqual(expect.objectContaining({ status: 'succeeded' }));

      const saved = await AgentMemory.findOne({ agentName: 'hosted-handoff', instanceId: 'default' }).lean();
      expect(saved.sections.long_term.content).toMatch(/^legacy seed\n\n\[[^\]]+\] hosted handoff marker$/);
      expect(saved.content).toBe(saved.sections.long_term.content);
      expect(saved.sections.long_term.source).toMatchObject({ runtime: 'native', via: 'native-tool' });
      // Run the CLI's ESM reader in Node, outside Jest's CommonJS transform.
      // Its CAP client receives the document read from real Mongo above.
      const bridgeUrl = pathToFileURL(path.resolve(__dirname, '../../../cli/src/lib/memory-bridge.js')).href;
      const cliMemory = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
        const { readLongTerm } = await import(process.argv[1]);
        let body = '';
        for await (const chunk of process.stdin) body += chunk;
        const memory = await readLongTerm({ get: async () => JSON.parse(body) });
        process.stdout.write(JSON.stringify(memory));
      `, bridgeUrl], { input: JSON.stringify(saved), encoding: 'utf8' }));
      expect(cliMemory).toBe(saved.sections.long_term.content);
      expect(cliMemory).toContain('hosted handoff marker');
    } finally {
      Object.entries(previous).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
    }
  });

  it('serializes overlapping appends and keeps v1/v2 memory aligned', async () => {
    await AgentMemory.create({
      agentName: 'native-race',
      instanceId: 'default',
      content: 'seed',
      sections: {
        long_term: {
          content: 'seed',
          visibility: 'private',
          byteSize: Buffer.byteLength('seed', 'utf8'),
        },
      },
    });

    await Promise.all(
      Array.from({ length: 12 }, (_, index) => appendLongTermMemory({
        agentName: 'native-race',
        instanceId: 'default',
        content: `concurrent note ${index}`,
        now: new Date(`2026-10-24T09:30:${String(index).padStart(2, '0')}.000Z`),
      })),
    );

    const saved = await AgentMemory.findOne({ agentName: 'native-race', instanceId: 'default' }).lean();
    const longTerm = saved.sections.long_term;
    expect(saved.content).toBe(longTerm.content);
    expect(longTerm.content).toContain('seed');
    for (let index = 0; index < 12; index += 1) {
      expect(longTerm.content).toContain(`concurrent note ${index}`);
    }
    expect(longTerm.byteSize).toBe(Buffer.byteLength(longTerm.content, 'utf8'));
    expect(longTerm.source).toMatchObject({ runtime: 'native', via: 'native-tool' });
    expect(longTerm.history).toHaveLength(10);
  });

  it('uses the legacy content as the prefix when no long_term section exists', async () => {
    await AgentMemory.create({
      agentName: 'legacy-native',
      instanceId: 'default',
      content: 'legacy note',
    });

    await appendLongTermMemory({
      agentName: 'legacy-native',
      instanceId: 'default',
      content: 'new native note',
      now: new Date('2026-10-24T09:40:00.000Z'),
    });

    const saved = await AgentMemory.findOne({ agentName: 'legacy-native', instanceId: 'default' }).lean();
    expect(saved.content).toBe('legacy note\n\n[2026-10-24T09:40:00.000Z] new native note');
    expect(saved.sections.long_term.content).toBe(saved.content);
    expect(saved.sections.long_term.history[0].content).toBe('legacy note');
  });

  it('writes through commonly_write_memory dispatch and persists both memory shapes', async () => {
    const result = await dispatchTool('commonly_write_memory', { content: 'dispatcher note' }, {
      installation: {},
      podId: 'dispatcher-pod',
      agentName: 'dispatcher-native',
      instanceId: 'default',
      displayName: 'Dispatcher Native',
      installationConfig: {},
      givenAddresses: new GivenAddresses(),
      ownUserId: null,
    });

    expect(result).toEqual({ content: { ok: true, written: true } });

    const saved = await AgentMemory.findOne({
      agentName: 'dispatcher-native',
      instanceId: 'default',
    }).lean();
    expect(saved.content).toContain('dispatcher note');
    expect(saved.sections.long_term.content).toBe(saved.content);
  });
});
