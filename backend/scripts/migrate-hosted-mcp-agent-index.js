/* eslint-disable no-console, import/extensions, import/no-unresolved */
/**
 * TASK-330 rollout step. The hosted-mcp unique index moves from
 * `(createdBy, config.entryId)` to `(createdBy, config.entryId, config.agentId)`
 * so one person may hold one operator key per agent. Mongo does not replace an
 * index in place, so the old one must go first, or the second agent's key
 * still fails with E11000.
 *
 * Read-only by default. --apply drops the old index if present and then builds
 * the declared one. It deletes no rows, so it cannot change which person holds
 * which connection. If the old index is still present after --apply, stop: the
 * new key is not safe to use yet.
 */
const mongoose = require('mongoose');

const Integration = require('../models/Integration');

const OLD_INDEX = 'createdBy_1_config.entryId_1';
const declared = Integration.schema.indexes().find(([keys, options]) => (
  keys.createdBy === 1 && keys['config.agentId'] === 1 && options.unique && options.partialFilterExpression
));
if (!declared) throw new Error('the agent-scoped hosted-mcp index is not declared on Integration');
const [keys, options] = declared;

async function listIndexes() {
  return Integration.collection.indexes().catch((error) => {
    if (error.code === 26) return [];
    throw error;
  });
}

async function run({ apply }) {
  const before = await listIndexes();
  const oldPresent = before.some((index) => index.name === OLD_INDEX);
  const newPresent = before.some((index) => index.name === options.name
    || JSON.stringify(index.key) === JSON.stringify(keys));
  console.log(JSON.stringify({ oldIndexPresent: oldPresent, newIndexPresent: newPresent, apply }));
  if (!apply) return;

  if (oldPresent) {
    await Integration.collection.dropIndex(OLD_INDEX);
    console.log(`dropped ${OLD_INDEX}`);
  }
  if (!newPresent) {
    await Integration.collection.createIndex(keys, { ...options });
    console.log('created the agent-scoped hosted-mcp index');
  }
  const after = await listIndexes();
  const stillOld = after.some((index) => index.name === OLD_INDEX);
  if (stillOld) throw new Error(`${OLD_INDEX} is still present; do not issue operator keys`);
  console.log('ok: old index gone, agent-scoped index present');
}

if (require.main === module) {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is required');
    process.exit(1);
  }
  // Only the CLI turns autoIndex off: a module-level set would leak into any
  // process that requires this file, the tests included.
  mongoose.set('autoIndex', false);
  mongoose.connect(uri)
    .then(() => run({ apply }))
    .then(() => mongoose.disconnect())
    .catch(async (error) => {
      console.error(error.message);
      await mongoose.disconnect();
      process.exit(1);
    });
}

module.exports = { run, OLD_INDEX };
