import mongoose, { Document, Model, Schema } from 'mongoose';

// ADR-003: Memory is a kernel primitive. The envelope below is the
// standardized shape every runtime driver promotes into. Runtime-opaque:
// no field names reference a specific driver (OpenClaw, webhook, etc.).

export type MemoryVisibility = 'private' | 'pod' | 'public';

export interface IMemorySection {
  content: string;
  visibility: MemoryVisibility;
  updatedAt: Date;
  byteSize: number;
}

export interface IDailySection {
  date: string; // YYYY-MM-DD
  content: string;
  visibility: MemoryVisibility;
}

export interface IRelationshipNote {
  otherInstanceId: string;
  notes: string;
  visibility: MemoryVisibility;
  updatedAt: Date;
}

export interface IAgentMemorySections {
  soul?: IMemorySection;
  long_term?: IMemorySection;
  daily?: IDailySection[];
  dedup_state?: IMemorySection;
  relationships?: IRelationshipNote[];
  shared?: IMemorySection;
  runtime_meta?: IMemorySection;
}

export interface IAgentMemory extends Document {
  agentName: string;
  instanceId: string;
  content: string; // v1 blob; still written during Phase 1 for compatibility
  sections?: IAgentMemorySections;
  sourceRuntime?: string;
  schemaVersion?: number;
  createdAt: Date;
  updatedAt: Date;
}

export const VISIBILITY_VALUES: MemoryVisibility[] = ['private', 'pod', 'public'];

// Phase 1 invariant: all section sub-fields use `default: undefined` so a newly
// created envelope does NOT auto-insert empty sub-documents. Callers opt in to
// each section by writing it explicitly. This keeps GET /memory responses
// small for fresh records and makes "section missing" distinguishable from
// "section set to empty."

const memorySectionSchema = new Schema<IMemorySection>(
  {
    content: { type: String, default: '' },
    visibility: { type: String, enum: VISIBILITY_VALUES, default: 'private' },
    updatedAt: { type: Date, default: Date.now },
    byteSize: { type: Number, default: 0 },
  },
  { _id: false },
);

const dailySectionSchema = new Schema<IDailySection>(
  {
    date: { type: String, required: true },
    content: { type: String, default: '' },
    visibility: { type: String, enum: VISIBILITY_VALUES, default: 'private' },
  },
  { _id: false },
);

const relationshipNoteSchema = new Schema<IRelationshipNote>(
  {
    otherInstanceId: { type: String, required: true },
    notes: { type: String, default: '' },
    visibility: { type: String, enum: VISIBILITY_VALUES, default: 'private' },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const agentMemorySectionsSchema = new Schema<IAgentMemorySections>(
  {
    soul: { type: memorySectionSchema, default: undefined },
    long_term: { type: memorySectionSchema, default: undefined },
    daily: { type: [dailySectionSchema], default: undefined },
    dedup_state: { type: memorySectionSchema, default: undefined },
    relationships: { type: [relationshipNoteSchema], default: undefined },
    shared: { type: memorySectionSchema, default: undefined },
    runtime_meta: { type: memorySectionSchema, default: undefined },
  },
  { _id: false },
);

const agentMemorySchema = new Schema<IAgentMemory>(
  {
    agentName: { type: String, required: true },
    instanceId: { type: String, default: 'default' },
    content: { type: String, default: '' },
    sections: { type: agentMemorySectionsSchema, default: undefined },
    sourceRuntime: { type: String, default: undefined },
    schemaVersion: { type: Number, default: undefined },
  },
  { timestamps: true },
);

agentMemorySchema.index({ agentName: 1, instanceId: 1 }, { unique: true });

const AgentMemory: Model<IAgentMemory> =
  (mongoose.models.AgentMemory as Model<IAgentMemory>) ||
  mongoose.model<IAgentMemory>('AgentMemory', agentMemorySchema);

export default AgentMemory;
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
