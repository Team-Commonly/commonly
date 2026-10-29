import mongoose, { Schema } from 'mongoose';

// Intentionally no TTL or takeover deadline: a stopped process can resume and
// still write User rows. Expiring its lock would admit a concurrent writer.
const schema = new Schema({
  _id: { type: String, required: true },
  owner: { type: String, required: true },
  acquiredAt: { type: Date, required: true },
}, { collection: 'admin_user_mutation_locks' });

export default mongoose.model('AdminUserMutationLock', schema);
// CJS compat: let require() return the default export directly.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
