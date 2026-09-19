/**
 * Resolve open handoff AttentionItems whose task is already `done`.
 *
 * The complete route wrote `done` without resolving the task's handoff cards
 * until 2026-09-19 (fixed alongside this script); every handoff that finished
 * through it stayed in the human's queue. This closes the backlog. Already
 * resolved rows are not touched; a task that no longer exists is left alone.
 *
 * Dry run by default:
 *   npm run sweep:done-task-handoffs
 * Apply:
 *   npm run sweep:done-task-handoffs -- --apply
 */
/* eslint-disable no-console */
const mongoose = require('mongoose');
const { sweepDoneTaskHandoffs } = require('../services/attentionItemService');

const APPLY = process.argv.includes('--apply');

export const main = async (): Promise<void> => {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  await mongoose.connect(process.env.MONGO_URI);
  try {
    const result = await sweepDoneTaskHandoffs({ apply: APPLY });
    console.log(JSON.stringify(result));
    if (!APPLY) console.log('DRY RUN — no AttentionItems changed. Re-run with --apply after review.');
  } finally {
    await mongoose.disconnect();
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error('done-task handoff sweep failed:', error);
    process.exit(1);
  });
}
