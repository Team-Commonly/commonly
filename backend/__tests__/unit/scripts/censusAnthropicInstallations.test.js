const mongoose = require('mongoose');
const { censusAnthropicInstallations, main } = require('../../../scripts/census-anthropic-installations');

const row = (runtimeType, model, environmentModel) => ({
  config: { runtime: { runtimeType, model }, environment: { model: environmentModel } },
});

describe('D76 dry-run-only Anthropic census', () => {
  it('counts hosted tiers and excludes local CLI, webhooks and unknown tiers regardless of Claude model', () => {
    const rows = [
      ...['native', 'hosted', 'internal', 'moltbot', 'managed-agents'].map((type) => row(type, 'claude-haiku-4-5')),
      ...['claude-code', 'codex', 'webhook', undefined, ''].map((type) => row(type, undefined, 'claude-sonnet-4-6')),
      row('native', 'deepseek-v4-flash'),
      row('native', 'anthropic/claude-opus-4-7'),
      row('hosted', 'openrouter/anthropic/claude-sonnet-4-6'),
      row('NATIVE ', undefined, ' CLAUDE-haiku-4-5 '),
      {},
    ];
    const before = JSON.stringify(rows);
    const result = censusAnthropicInstallations(rows);
    expect(result).toMatchObject({ dryRun: true, scanned: 15, hostedCandidates: 8, excludedByoOrUnknown: 5 });
    expect(result.byRuntime).toMatchObject({ native: 3, hosted: 2, unset: 2, 'claude-code': 1, codex: 1 });
    expect(JSON.stringify(rows)).toBe(before);
  });

  it.each(['--apply', '--dry-run', '--unknown'])('rejects %s before connecting or writing', async (arg) => {
    const connect = jest.spyOn(mongoose, 'createConnection');
    try {
      await expect(main([arg])).rejects.toThrow('Read-only census');
      expect(connect).not.toHaveBeenCalled();
    } finally { connect.mockRestore(); }
  });
});

it('reads real Mongo without changing BYO/hosted documents or indexes', async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri('d76-census');
  const connection = await mongoose.createConnection(uri).asPromise();
  const collection = connection.collection('agentinstallations');
  const oldUri = process.env.MONGO_URI;
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await collection.insertMany([
      row('native', 'claude-haiku-4-5'),
      row('claude-code', undefined, 'claude-sonnet-4-6'),
      row(undefined, undefined, 'claude-opus-4-7'),
    ]);
    const documents = await collection.find({}).toArray();
    const indexes = await collection.indexes();
    process.env.MONGO_URI = uri;
    await main([]);
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
      scanned: 3, hostedCandidates: 1, excludedByoOrUnknown: 2, dryRun: true,
    });
    expect(await collection.find({}).toArray()).toEqual(documents);
    expect(await collection.indexes()).toEqual(indexes);
  } finally {
    if (oldUri === undefined) delete process.env.MONGO_URI;
    else process.env.MONGO_URI = oldUri;
    log.mockRestore();
    await connection.close();
    await mongo.stop();
  }
});
