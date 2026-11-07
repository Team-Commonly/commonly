// Two indexes on one key get one default name, and Mongo refuses the second.
// autoIndex swallows that, so production ran with no collated username index
// and nothing said so.
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

const modelsDir = path.join(__dirname, '../../models');
fs.readdirSync(modelsDir)
  .filter((file) => /\.(ts|js)$/.test(file) && !file.endsWith('.d.ts'))
  .forEach((file) => require(path.join(modelsDir, file)));

const defaultName = (keys) => Object.entries(keys).map(([field, order]) => `${field}_${order}`).join('_');

describe('model indexes', () => {
  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);

  it('no model declares two different indexes under one name', () => {
    const clashes = Object.values(mongoose.models).flatMap((model) => {
      const seen = new Map();
      return model.schema.indexes().flatMap(([keys, { background, ...options } = {}]) => {
        const name = options.name || defaultName(keys);
        const spec = JSON.stringify(options);
        if (seen.has(name) && seen.get(name) !== spec) return [`${model.modelName}.${name}`];
        seen.set(name, spec);
        return [];
      });
    });
    expect(clashes).toEqual([]);
  });

  it('builds the collated username index beside the unique one', async () => {
    const User = mongoose.model('User');
    await User.createIndexes();
    const usernames = (await User.collection.indexes()).filter((index) => index.key.username);
    expect(usernames.find((index) => index.name === 'username_1')?.unique).toBe(true);
    expect(usernames.find((index) => index.name === 'username_label')?.collation?.strength).toBe(2);
  });
});
