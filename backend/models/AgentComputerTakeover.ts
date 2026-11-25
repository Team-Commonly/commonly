import mongoose, { Schema } from 'mongoose';
import { dualStorePlugin } from '../repositories/dualStore';

const schema = new Schema({
  _id: { type: Schema.Types.ObjectId, required: true }, // AgentInstallation id
  ownerId: { type: Schema.Types.ObjectId, required: true, index: true },
  active: { type: Boolean, required: true },
  // CDP target identity is browser-owned. Page script can rewrite window.name.
  targetId: { type: String },
}, { timestamps: true });

// ADR-034 step 2: the repair markers (pgVersion, pgPending, pgDeleted) and their sparse index.
dualStorePlugin(schema);

export const AgentComputerTakeover = mongoose.models.AgentComputerTakeover
  || mongoose.model('AgentComputerTakeover', schema);
