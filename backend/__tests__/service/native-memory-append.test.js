const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

const AgentMemory = require('../../models/AgentMemory');
const { appendLongTermMemory } = require('../../services/agentMemoryService');

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
});
