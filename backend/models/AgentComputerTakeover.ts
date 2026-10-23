import mongoose, { Schema } from 'mongoose';

const schema = new Schema({
  _id: { type: Schema.Types.ObjectId, required: true }, // AgentInstallation id
  ownerId: { type: Schema.Types.ObjectId, required: true, index: true },
  active: { type: Boolean, required: true },
}, { timestamps: true });

export const AgentComputerTakeover = mongoose.models.AgentComputerTakeover
  || mongoose.model('AgentComputerTakeover', schema);
