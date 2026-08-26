import mongoose, { Document, Schema, Types } from 'mongoose';

export type PodType =
  | 'chat'
  | 'study'
  | 'games'
  | 'agent-ensemble'
  | 'agent-admin'
  | 'agent-room'
  | 'agent-dm'
  | 'team';

// Per-pod alias → agent binding (e.g. "codex" → sam-local-codex). Empty by
// default; lookups fall through to the agent's own contact list per the
// agent collaboration plan §3.2.
export interface PodContactBinding {
  agentName: string;
  instanceId: string;
}
export type PodJoinPolicy = 'open' | 'invite-only';
export type EnsembleParticipantRole = 'starter' | 'responder' | 'synthesizer' | 'observer';
export type HumanParticipation = 'none' | 'read-only' | 'participate';

export interface IEnsembleParticipant {
  agentType: string;
  instanceId: string;
  role: EnsembleParticipantRole;
}

export interface IPod extends Document {
  name: string;
  description?: string;
  type: PodType;
  // OPTIONAL, and the `?` is load-bearing. The schema below defaults this
  // to 'open', but a mongoose default applies on WRITE — documents created
  // before the field existed have no `joinPolicy` at all. (No count here on
  // purpose: a census in a permanent comment is stale the moment rows are
  // written, and the type is justified by one such row existing — or by the
  // possibility of one — not by how many there are today.) Declaring it
  // required told a type-checking
  // reader the field is always present, which licenses `=== 'open'`; that
  // test is false for every legacy row and would fail CLOSED, silently
  // hiding pods that are in fact joinable.
  //
  // Read it as `!== 'invite-only'` (fail open), never `=== 'open'`. That is
  // what every production read already does, and what DIRECTLY_JOINABLE_QUERY
  // encodes as `{ $ne: 'invite-only' }` — see services/podListing.ts, whose
  // own CommunityListingPod already declared the field optional. The two
  // declarations of one field disagreed; this is the one that was wrong.
  joinPolicy?: PodJoinPolicy;
  parentPod?: Types.ObjectId | null;
  agentEnsemble: {
    enabled: boolean;
    topic?: string;
    participants: IEnsembleParticipant[];
    stopConditions: {
      maxMessages: number;
      maxRounds: number;
      maxDurationMinutes: number;
    };
    schedule: {
      enabled: boolean;
      frequencyMinutes: number;
      timezone: string;
    };
    humanParticipation: HumanParticipation;
  };
  createdBy: Types.ObjectId;
  members: Types.ObjectId[];
  // Canonical unordered two-member key for agent-dm pods. The partial unique
  // index below is the storage-level backstop for concurrent DM creation.
  // Optional because legacy pods predate the key and are claimed lazily by
  // DMService rather than being rewritten by a schema migration at startup.
  agentDmPairKey?: string;
  messages: Types.ObjectId[];
  announcements: Types.ObjectId[];
  externalLinks: Types.ObjectId[];
  // Optional alias → agent map for resolving cross-pod mentions like
  // `@codex` to a specific installed agent. Stored as a Mongo Map so reads
  // are O(1) and unset rows return an empty Map by default.
  contacts?: Map<string, PodContactBinding>;
  // Admin-set only — when true this pod is anonymously readable via the
  // dedicated /api/showcase endpoints (and ONLY those). Never set on a
  // personal pod type (agent-dm / agent-room / agent-admin); the admin
  // toggle rejects those. Defaults false so every existing pod is private.
  publicRead: boolean;
  // Community-tab listing is OPT-IN and separate from readability: publicRead
  // grants anonymous/showcase READ access; communityListed additionally puts
  // the pod on the Community discovery surface. Showcase rooms (Eng Milestone
  // etc.) stay publicRead but unlisted. Listing is admin-curated for now; an
  // owner-side "request listing" flow is the planned phase 2 (Sam 2026-07-22).
  communityListed: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const PodSchema = new Schema<IPod>(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    type: {
      type: String,
      enum: ['chat', 'study', 'games', 'agent-ensemble', 'agent-admin', 'agent-room', 'agent-dm', 'team'],
      default: 'chat',
    },
    joinPolicy: {
      type: String,
      enum: ['open', 'invite-only'],
      default: 'open',
    },
    parentPod: { type: Schema.Types.ObjectId, ref: 'Pod', default: null },
    agentEnsemble: {
      enabled: { type: Boolean, default: false },
      topic: String,
      participants: [
        {
          agentType: { type: String, required: true },
          instanceId: { type: String, default: 'default' },
          role: {
            type: String,
            enum: ['starter', 'responder', 'synthesizer', 'observer'],
            default: 'responder',
          },
        },
      ],
      stopConditions: {
        maxMessages: { type: Number, default: 20 },
        maxRounds: { type: Number, default: 5 },
        maxDurationMinutes: { type: Number, default: 60 },
      },
      schedule: {
        enabled: { type: Boolean, default: false },
        frequencyMinutes: { type: Number, default: 20 },
        timezone: { type: String, default: 'UTC' },
      },
      humanParticipation: {
        type: String,
        enum: ['none', 'read-only', 'participate'],
        default: 'participate',
      },
    },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    members: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    agentDmPairKey: { type: String, trim: true },
    messages: [{ type: Schema.Types.ObjectId, ref: 'Message' }],
    announcements: [{ type: Schema.Types.ObjectId, ref: 'Announcement' }],
    externalLinks: [{ type: Schema.Types.ObjectId, ref: 'ExternalLink' }],
    // Per-pod alias → agent binding. Defaults to an empty Map so existing
    // documents return `pod.contacts.get(alias) === undefined` cleanly
    // without throwing on legacy rows that never set the field.
    contacts: {
      type: Map,
      of: new Schema<PodContactBinding>({
        agentName: { type: String, required: true },
        instanceId: { type: String, required: true },
      }, { _id: false }),
      default: () => new Map(),
    },
    // Admin-set only; never on personal pod types. Gates the anonymous
    // /api/showcase read path. See backend/routes/showcase.ts.
    publicRead: { type: Boolean, default: false },
    communityListed: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

PodSchema.pre<IPod>('save', function (next) {
  if (this.isNew && !this.members.includes(this.createdBy)) {
    this.members.push(this.createdBy);
  }
  next();
});

// `members` is a multikey array, so it cannot express uniqueness of an
// unordered two-member pair. DMService writes the canonical scalar key and
// this index elects one winner when two callers create the same agent DM at
// once. Keep the index partial: legacy pods have no key, and an explicit null
// would otherwise collide under a unique index.
PodSchema.index(
  { agentDmPairKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      type: 'agent-dm',
      agentDmPairKey: { $type: 'string' },
    },
  },
);

export default mongoose.model<IPod>('Pod', PodSchema);
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
