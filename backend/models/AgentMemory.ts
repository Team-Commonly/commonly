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

// ADR-012 §1: structured entries for system-driven exchange records.
// Visibility is hard-coded 'private' at the schema level (see ADR-012 §6).
export type SystemExchangeKind =
  | 'agent-dm-conclusion'
  | 'agent-dm-loop-trip'
  | 'task-completed'
  | 'cross-pod-mention'; // reserved for v1.x — not emitted in v1 (ADR-012 §4)

export interface ISystemExchangeEntry {
  ts: Date;                          // when the event happened
  kind: SystemExchangeKind;
  surfacePodId: string;              // where the event happened
  surfaceLabel: string;              // human-readable, e.g. "agent-dm:69f7..." or "team:Backend Tasks"
  peers: string[];                   // other instanceIds involved (excluding self)
  takeaway: string;                  // ≤ 280 chars; verbatim metadata in v1
}

export interface ISystemExchangesSection {
  entries: ISystemExchangeEntry[];   // most recent first; cap at 50 (ADR-012 §5)
  visibility: 'private';             // hard-coded; widening is closed
  updatedAt: Date;
  // ADR-012 Phase 1 deliberately omits `byteSize` — appendSystemExchange does
  // not maintain it under concurrent $push, and no Phase 1 reader consumes
  // it. Phase 2's digest builder recomputes from `entries` directly. Re-add
  // here when there's a reader that benefits from the cached value.
}

export interface IAgentMemorySections {
  soul?: IMemorySection;
  long_term?: IMemorySection;
  daily?: IDailySection[];
  dedup_state?: IMemorySection;
  relationships?: IRelationshipNote[];
  shared?: IMemorySection;
  runtime_meta?: IMemorySection;
  // ADR-012: system-driven exchange records. Read-only from the agent's
  // tool surface; written only by platform hooks (agentMemoryService.appendSystemExchange).
  system_exchanges?: ISystemExchangesSection;
}

export interface IAgentMemory extends Document {
  agentName: string;
  instanceId: string;
  content: string; // v1 blob; still written during Phase 1 for compatibility
  sections?: IAgentMemorySections;
  sourceRuntime?: string;
  schemaVersion?: number;
  // ADR-003 Phase 2: idempotent-dedup key for POST /memory/sync, scoped
  // (dayBucket + sourceRuntime + contentHash). Repeated identical syncs
  // within the same day bucket return early with { deduped: true }.
  lastSyncKey?: string;
  lastSyncAt?: Date;
  // ADR-012: monotone revision bumped on every system_exchanges write.
  // memoryDigest in CAP event payload is computed against `lastSeenRevision`.
  revision?: number;
  lastSeenRevision?: number;
  createdAt: Date;
  updatedAt: Date;
}

export const VISIBILITY_VALUES: MemoryVisibility[] = ['private', 'pod', 'public'];

// ADR-012 §4: trigger taxonomy. v1 emits the first three; cross-pod-mention
// is reserved for v1.x consideration.
export const SYSTEM_EXCHANGE_KINDS: SystemExchangeKind[] = [
  'agent-dm-conclusion',
  'agent-dm-loop-trip',
  'task-completed',
  'cross-pod-mention',
];

// ADR-012 §1: ≤280 chars, enforced server-side (truncation responsibility
// lives in appendSystemExchange callers — schema validates the post-truncation
// invariant). The cap also bounds the digest serialization budget.
export const SYSTEM_EXCHANGE_TAKEAWAY_MAX = 280;
// ADR-012 §5: count-bounded eviction. Oldest entry evicted on overflow.
export const SYSTEM_EXCHANGE_ENTRY_CAP = 50;
// ADR-012 §1 — writable sections (the agent's tool can address these via
// commonly_save_my_memory). `system_exchanges` is intentionally excluded.
export const AGENT_WRITABLE_SECTIONS = [
  'soul',
  'long_term',
  'dedup_state',
  'shared',
  'runtime_meta',
  'daily',
  'relationships',
] as const;
export type AgentWritableSection = typeof AGENT_WRITABLE_SECTIONS[number];

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

const systemExchangeEntrySchema = new Schema<ISystemExchangeEntry>(
  {
    ts: { type: Date, required: true },
    kind: { type: String, enum: SYSTEM_EXCHANGE_KINDS, required: true },
    surfacePodId: { type: String, required: true },
    surfaceLabel: { type: String, default: '' },
    peers: { type: [String], default: [] },
    takeaway: {
      type: String,
      default: '',
      // ADR-012 §1: 280-char cap. Callers truncate with `…` suffix; the
      // schema guards against bypass. Validation runs on $push via runValidators.
      validate: {
        validator: (v: string) => typeof v === 'string' && v.length <= SYSTEM_EXCHANGE_TAKEAWAY_MAX,
        message: `takeaway must be ≤ ${SYSTEM_EXCHANGE_TAKEAWAY_MAX} chars`,
      },
    },
  },
  { _id: false },
);

const systemExchangesSectionSchema = new Schema<ISystemExchangesSection>(
  {
    entries: { type: [systemExchangeEntrySchema], default: [] },
    // ADR-012 §6: hard-coded 'private'. The enum is single-valued so any
    // attempt to widen at the document level fails Mongoose validation.
    visibility: { type: String, enum: ['private'], default: 'private' },
    updatedAt: { type: Date, default: Date.now },
    // byteSize intentionally omitted in Phase 1 — see ISystemExchangesSection.
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
    system_exchanges: { type: systemExchangesSectionSchema, default: undefined },
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
    lastSyncKey: { type: String, default: undefined },
    lastSyncAt: { type: Date, default: undefined },
    // ADR-012 §2: monotone revision; bumped on every appendSystemExchange.
    // lastSeenRevision is bumped when an event carrying memoryDigest is acked
    // (Phase 2). Both default to 0 so a fresh agent's first digest is empty.
    revision: { type: Number, default: 0 },
    lastSeenRevision: { type: Number, default: 0 },
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
