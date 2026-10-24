/** TASK-443: direct writes deliberately bypass task events and timestamps. */
import mongoose from 'mongoose';
import Task from '../models/Task';
import { isTaskPriority } from '../utils/taskPriority';

export async function migrateTaskPriority(dryRun = true): Promise<{ matched: number; modified: number }> {
  const cursor = Task.collection.find({ status: { $in: ['pending', 'claimed', 'blocked'] } });
  let matched = 0;
  let modified = 0;
  for await (const row of cursor) {
    const prefix = /^\[(P[0-3])\]\s*/.exec(row.title);
    const priority = isTaskPriority(row.priority) ? row.priority : prefix?.[1] || 'P2';
    const suffix = prefix ? row.title.slice(prefix[0].length) : '';
    const title = prefix && suffix.trim() ? suffix : row.title;
    if (row.priority === priority && row.title === title) continue;
    matched += 1;
    if (!dryRun) {
      // CAS protects a title or priority edited since this row was read. Native
      // collection updates preserve updatedAt/offeredAt and invoke no hooks.
      // eslint-disable-next-line no-await-in-loop
      const result = await Task.collection.updateOne(
        { _id: row._id, title: row.title, status: row.status, updatedAt: row.updatedAt, priority: row.priority === undefined ? { $exists: false } : row.priority },
        { $set: { priority, title } },
      );
      modified += result.modifiedCount;
    }
  }
  return { matched, modified };
}

if (require.main === module) {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is required');
  mongoose.set('autoIndex', false);
  mongoose.connect(uri).then(async () => {
    try {
      console.log(await migrateTaskPriority(!process.argv.includes('--apply')));
    } finally {
      await mongoose.disconnect();
    }
  }).catch((error) => { console.error(error); process.exitCode = 1; });
}
