/* eslint-disable no-console, import/extensions, import/no-unresolved */
/**
 * TASK-262 rollout gate. Read-only by default; --apply creates only the
 * declared unique index after the operator has resolved existing duplicates.
 * Never chooses which person's Slack connection to deactivate.
 */
const mongoose = require('mongoose');

mongoose.set('autoIndex', false);
const Integration = require('../models/Integration');

const INDEX = 'unique_active_slack_dm';
const declared = Integration.schema.indexes().find(([, options]) => options.name === INDEX);
if (!declared) throw new Error(`${INDEX} is not declared on Integration`);
const [keys, options] = declared;

async function inspectSlackDmBindings() {
  const duplicates = await Integration.aggregate([
    { $match: options.partialFilterExpression },
    {
      $group: {
        _id: { teamId: '$config.teamId', chatId: '$config.chatId' },
        rows: {
          $push: {
            id: '$_id', createdBy: '$createdBy', podId: '$podId', installationId: '$installationId',
          },
        },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $sort: { '_id.teamId': 1, '_id.chatId': 1 } },
  ]);
  const indexes = await Integration.collection.indexes().catch((error) => {
    if (error.code === 26) return [];
    throw error;
  });
  return { duplicates, indexPresent: indexes.some((index) => index.name === INDEX) };
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  await mongoose.connect(process.env.MONGO_URI);
  try {
    const result = await inspectSlackDmBindings();
    console.log(JSON.stringify(result, null, 2));
    if (!process.argv.includes('--apply')) return;
    if (result.duplicates.length) {
      throw new Error('Resolve every duplicate active Slack DM before creating the unique index.');
    }
    await Integration.collection.createIndex(keys, options);
    console.log(`${INDEX} present`);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[ensure-unique-slack-dm] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { inspectSlackDmBindings };
