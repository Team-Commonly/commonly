import mongoose, { Document, Model, Schema, Types } from 'mongoose';

/**
 * Installable — unified catalog model for every kind of thing a user (or agent)
 * can install into a Commonly space.
 *
 * Replaces the pre-v2 `App` + `AgentRegistry` split. A single Installable carries
 * one or more polymorphic `components` (agent, slash-command, event-handler,
 * scheduled-job, widget, webhook, data-schema), so a single marketplace entry
 * can ship a bundle (e.g. an agent + its companion slash command + a widget)
 * while preserving component-level addressing and scoping.
 *
 * STEP 1 / 8 of the Installable taxonomy refactor. This file is pure
 * scaffolding: schema + types + indexes. No services, routes, adapters, or
 * static/instance methods. Phase 2 will add adapter services that dual-write
 * into this collection alongside the existing App/AgentRegistry rows, and
 * later phases will move reads here once coverage is verified.
 *
 * See: docs/adr/ADR-001-installable-taxonomy.md
 */

// ---------------------------------------------------------------------------
// Axis types
// ---------------------------------------------------------------------------

export type InstallableSource =
  | 'builtin'
  | 'marketplace'
  | 'user'
  | 'template'
  | 'remote';

/**
 * Installable kind — marketplace surface hint. Two orthogonal axes (source ×
 * components) describe what an Installable *is*; `kind` tells the marketplace
 * which aisle to shelve it in and which landing page to render.
 *
 * - 'agent'  → the product IS an identity you hire (Liz, Sarah the Legal
 *              Researcher, Multica's task-dispatcher). components[] must
 *              contain exactly one Agent, optionally plus Skill components
 *              the agent brings with it.
 * - 'app'    → the product is capability (Notion integration, GitHub sync).
 *              components[] may include Agent, but the Agent is an
 *              extension of the app, not the main product. Widgets /
 *              slash commands / event handlers typically dominate.
 * - 'skill'  → a pure capability file — agent-facing only, no runtime of
 *              its own. Installs into the skill registry at the declared
 *              scope; any agent in that scope can pick it up by id.
 * - 'bundle' → a grouping of the above, published together.
 *
 * `kind` is a UX hint, not a schema partition — the underlying model is
 * still one table. See docs/adr/ADR-001-installable-taxonomy.md (2026-04-12
 * amendment).
 */
export type InstallableKind = 'agent' | 'app' | 'skill' | 'bundle';

export type InstallableScope = 'instance' | 'pod' | 'user' | 'dm';

export type InstallableStatus =
  | 'active'
  | 'deprecated'
  | 'unpublished'
  | 'pending-review';

export type ComponentType =
  | 'agent'
  | 'slash-command'
  | 'event-handler'
  | 'scheduled-job'
  | 'widget'
  | 'webhook'
  | 'data-schema'
  | 'skill';

export type AddressMode =
  | '@mention'
  | '/command'
  | 'event'
  | 'schedule'
  | 'webhook';

export type ComponentRuntime =
  | 'native'
  | 'moltbot'
  | 'webhook'
  | 'claude-code'
  | 'managed-agents'
  | 'internal'
  | 'remote';

export type ComponentMemoryStrategy = 'persistent' | 'scratch' | 'none';

export type SlashCommandParameterType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'user'
  | 'channel';

export type WidgetLocation =
  | 'pod-sidebar'
  | 'pod-header'
  | 'dashboard-main'
  | 'message-inline';

// ---------------------------------------------------------------------------
// Component sub-shapes
// ---------------------------------------------------------------------------

export interface IAddress {
  mode: AddressMode;
  /**
   * Free-form identifier interpreted against `mode`:
   *   '@mention'   → "@task-clerk"
   *   '/command'   → "/task"
   *   'event'      → "pod.join"
   *   'schedule'   → "0 *\/6 * * *"
   *   'webhook'    → "/api/webhooks/discord"
   */
  identifier: string;
}

export interface IComponentPersona {
  displayName?: string;
  avatar?: string;
  systemPrompt?: string;
  memoryStrategy?: ComponentMemoryStrategy;
}

export interface ISlashCommandParameter {
  name: string;
  type: SlashCommandParameterType;
  required?: boolean;
  description?: string;
}

export interface IComponent {
  // Shared
  name: string;
  type: ComponentType;
  version?: string;
  description?: string;

  // Addressing — a component may respond to multiple channels.
  addresses?: IAddress[];

  // Subset of the parent Installable.requires that this component needs.
  scopes?: string[];

  // Agent-specific ----------------------------------------------------------
  runtime?: ComponentRuntime;
  persona?: IComponentPersona;

  // SlashCommand-specific ---------------------------------------------------
  commandName?: string;
  /**
   * Handler reference: "agent:task-clerk" | "webhook:https://..." |
   * "internal:summarize". Same reference format used by eventHandler and
   * jobHandler below so the router can dispatch uniformly.
   */
  commandHandler?: string;
  commandParameters?: ISlashCommandParameter[];

  // EventHandler-specific ---------------------------------------------------
  eventType?: string;
  eventHandler?: string;

  // ScheduledJob-specific ---------------------------------------------------
  cron?: string;
  jobHandler?: string;

  // Widget-specific ---------------------------------------------------------
  widgetLocation?: WidgetLocation;
  widgetUrl?: string;
  widgetConfigSchema?: unknown;

  // Webhook-specific --------------------------------------------------------
  webhookPath?: string;
  webhookEvents?: string[];

  // DataSchema-specific -----------------------------------------------------
  schemaName?: string;
  schemaFields?: unknown;

  // Skill-specific ----------------------------------------------------------
  // Skills are agent-only — no `addresses`, no human-facing invocation. A
  // skill is a unit of "how to do X well" that agents compose into their
  // working set. Installing a Skill adds it to the skill registry at the
  // parent Installable's scope; any agent in that scope can reference it.
  skillId?: string;
  skillPrompt?: string;
  skillTools?: string[];
  skillExamples?: unknown;

  // Component-level free-form metadata.
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Top-level sub-shapes
// ---------------------------------------------------------------------------

export interface IMarketplaceMeta {
  published: boolean;
  category: string;
  tags: string[];
  logo?: string;
  screenshots?: string[];
  verified: boolean;
  rating: number;
  ratingCount: number;
  installCount: number;
}

export interface IRemoteMeta {
  origin: string;
  federationProtocol?: string;
  remoteId?: string;
}

export interface IPublisherMeta {
  userId?: Types.ObjectId;
  organizationId?: Types.ObjectId;
  name?: string;
}

export interface IVersionEntry {
  version: string;
  publishedAt: Date;
  deprecated?: boolean;
  deprecationReason?: string;
}

export interface IInstallableStats {
  totalInstalls: number;
  activeInstalls: number;
  forkCount: number;
  lastActivity?: Date;
}

export interface IForkedFrom {
  installableId: string;
  version: string;
  forkedAt: Date;
}

// ---------------------------------------------------------------------------
// Top-level document
// ---------------------------------------------------------------------------

export interface IInstallable extends Document {
  // Identity
  installableId: string;
  name: string;
  description: string;
  version: string;

  // Marketplace surface hint — which aisle to shelve this in. See
  // InstallableKind doc above. Defaults to 'app' if not supplied by the
  // manifest, which is the safest browse location for a package we can't
  // classify automatically.
  kind: InstallableKind;

  // Axis 1: provenance
  source: InstallableSource;

  // Where this may be installed
  scope: InstallableScope;

  // OAuth-style capability declaration. Enforcement is permissive in v1,
  // but the declaration MUST exist from day one.
  requires: string[];

  // Axis 2: what it ships
  components: IComponent[];

  // Source-specific metadata
  marketplace?: IMarketplaceMeta;
  remote?: IRemoteMeta;
  owner?: Types.ObjectId;
  publisher?: IPublisherMeta;

  // Lifecycle
  status: InstallableStatus;

  // Version history (for marketplace packages with deprecation/rollback)
  versions?: IVersionEntry[];

  // Fork lineage
  forkedFrom?: IForkedFrom;

  // Long-form description for detail page
  readme?: string;

  // Stats
  stats: IInstallableStats;

  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

const AddressSchema = new Schema<IAddress>(
  {
    mode: {
      type: String,
      enum: ['@mention', '/command', 'event', 'schedule', 'webhook'],
      required: true,
    },
    identifier: { type: String, required: true },
  },
  { _id: false },
);

const ComponentPersonaSchema = new Schema<IComponentPersona>(
  {
    displayName: { type: String },
    avatar: { type: String },
    systemPrompt: { type: String },
    memoryStrategy: {
      type: String,
      enum: ['persistent', 'scratch', 'none'],
    },
  },
  { _id: false },
);

const SlashCommandParameterSchema = new Schema<ISlashCommandParameter>(
  {
    name: { type: String, required: true },
    type: {
      type: String,
      enum: ['string', 'number', 'boolean', 'user', 'channel'],
      required: true,
    },
    required: { type: Boolean },
    description: { type: String },
  },
  { _id: false },
);

const ComponentSchema = new Schema<IComponent>(
  {
    name: { type: String, required: true },
    type: {
      type: String,
      enum: [
        'agent',
        'slash-command',
        'event-handler',
        'scheduled-job',
        'widget',
        'webhook',
        'data-schema',
        'skill',
      ],
      required: true,
    },
    version: { type: String },
    description: { type: String },

    addresses: { type: [AddressSchema], default: undefined },
    scopes: { type: [String], default: undefined },

    // Agent
    runtime: {
      type: String,
      enum: [
        'native',
        'moltbot',
        'webhook',
        'claude-code',
        'managed-agents',
        'internal',
        'remote',
      ],
    },
    persona: { type: ComponentPersonaSchema },

    // SlashCommand
    commandName: { type: String },
    commandHandler: { type: String },
    commandParameters: { type: [SlashCommandParameterSchema], default: undefined },

    // EventHandler
    eventType: { type: String },
    eventHandler: { type: String },

    // ScheduledJob
    cron: { type: String },
    jobHandler: { type: String },

    // Widget
    widgetLocation: {
      type: String,
      enum: ['pod-sidebar', 'pod-header', 'dashboard-main', 'message-inline'],
    },
    widgetUrl: { type: String },
    widgetConfigSchema: { type: Schema.Types.Mixed },

    // Webhook
    webhookPath: { type: String },
    webhookEvents: { type: [String], default: undefined },

    // DataSchema
    schemaName: { type: String },
    schemaFields: { type: Schema.Types.Mixed },

    // Skill (agent-only — no addresses, no runtime of its own)
    skillId: { type: String },
    skillPrompt: { type: String },
    skillTools: { type: [String], default: undefined },
    skillExamples: { type: Schema.Types.Mixed },

    // Free-form component metadata
    metadata: { type: Schema.Types.Mixed },
  },
  { _id: false },
);

const MarketplaceSubSchema = new Schema<IMarketplaceMeta>(
  {
    published: { type: Boolean, default: false },
    category: { type: String, default: '' },
    tags: { type: [String], default: [] },
    logo: { type: String },
    screenshots: { type: [String], default: undefined },
    verified: { type: Boolean, default: false },
    rating: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
    installCount: { type: Number, default: 0 },
  },
  { _id: false },
);

const RemoteSubSchema = new Schema<IRemoteMeta>(
  {
    origin: { type: String, required: true },
    federationProtocol: { type: String },
    remoteId: { type: String },
  },
  { _id: false },
);

const PublisherSubSchema = new Schema<IPublisherMeta>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    organizationId: { type: Schema.Types.ObjectId },
    name: { type: String },
  },
  { _id: false },
);

const VersionSubSchema = new Schema<IVersionEntry>(
  {
    version: { type: String, required: true },
    publishedAt: { type: Date, required: true },
    deprecated: { type: Boolean },
    deprecationReason: { type: String },
  },
  { _id: false },
);

const ForkedFromSubSchema = new Schema<IForkedFrom>(
  {
    installableId: { type: String, required: true },
    version: { type: String, required: true },
    forkedAt: { type: Date, required: true },
  },
  { _id: false },
);

// ---------------------------------------------------------------------------
// Top-level schema
// ---------------------------------------------------------------------------

const InstallableSchema = new Schema<IInstallable>(
  {
    installableId: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      // Allow "bare-name", "scope/name", or "@scope/name"
      match: /^(@[a-z0-9-]+\/)?[a-z0-9-]+$/,
    },
    name: { type: String, required: true },
    description: { type: String, required: true, default: '' },
    version: { type: String, required: true },

    kind: {
      type: String,
      enum: ['agent', 'app', 'skill', 'bundle'],
      required: true,
      default: 'app',
    },

    source: {
      type: String,
      enum: ['builtin', 'marketplace', 'user', 'template', 'remote'],
      required: true,
    },
    scope: {
      type: String,
      enum: ['instance', 'pod', 'user', 'dm'],
      required: true,
    },

    requires: { type: [String], default: [] },
    components: { type: [ComponentSchema], default: [] },

    marketplace: { type: MarketplaceSubSchema },
    remote: { type: RemoteSubSchema },
    owner: { type: Schema.Types.ObjectId, ref: 'User' },
    publisher: { type: PublisherSubSchema },

    status: {
      type: String,
      enum: ['active', 'deprecated', 'unpublished', 'pending-review'],
      default: 'active',
    },

    versions: { type: [VersionSubSchema], default: undefined },

    forkedFrom: { type: ForkedFromSubSchema },
    readme: { type: String },

    stats: {
      totalInstalls: { type: Number, default: 0 },
      activeInstalls: { type: Number, default: 0 },
      forkCount: { type: Number, default: 0 },
      lastActivity: { type: Date },
    },
  },
  { timestamps: true },
);

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

// `installableId` is already unique via the field definition, but an explicit
// index declaration keeps the intent visible alongside the others below.
InstallableSchema.index({ installableId: 1 }, { unique: true });
InstallableSchema.index({ source: 1, status: 1 });
InstallableSchema.index({ kind: 1, 'marketplace.published': 1 });
InstallableSchema.index({ 'marketplace.published': 1, 'marketplace.category': 1 });
InstallableSchema.index({ 'publisher.userId': 1 });
InstallableSchema.index({ 'forkedFrom.installableId': 1 });
InstallableSchema.index(
  { name: 'text', description: 'text', 'marketplace.tags': 'text' },
  { name: 'marketplace_text_search' },
);

// ---------------------------------------------------------------------------
// Model export (HMR guard)
// ---------------------------------------------------------------------------

const Installable: Model<IInstallable> =
  (mongoose.models.Installable as Model<IInstallable>) ||
  mongoose.model<IInstallable>('Installable', InstallableSchema);

export default Installable;
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
