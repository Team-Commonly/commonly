import mongoose, { Document, Model, Schema, Types } from 'mongoose';

import type { ComponentType, InstallableScope } from './Installable';

/**
 * InstallableInstallation — per-target installation record for an Installable.
 *
 * One row per (installable, target). The parent `installableId` is logically a
 * foreign key to `Installable.installableId` — Mongoose does not enforce
 * referential integrity, but the adapter services in Phase 2 must treat it as
 * a hard constraint on create/update.
 *
 * The document contains a `components[]` sub-array that mirrors the component
 * layout in the parent Installable. Each entry carries its own status and
 * `projectionIds` pointing at the rows in the legacy per-component runtime
 * tables (AgentInstallation / SlashCommandRegistration / etc.) that were
 * created by projecting this component at install time. This gives us a
 * stable cross-reference during the dual-write migration.
 *
 * STEP 1 / 8 of the Installable taxonomy refactor. Pure scaffolding: schema +
 * types + indexes. No services, routes, adapters, or methods.
 *
 * See: docs/adr/ADR-001-installable-taxonomy.md
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InstallationTargetType = 'pod' | 'user' | 'dm' | 'instance';

export type InstallationStatus =
  | 'installing'
  | 'activating'
  | 'uninstalling'
  | 'active'
  | 'paused'
  | 'uninstalled'
  | 'error'
  | 'stale';

export type InstallSource = 'marketplace' | 'registry' | 'direct' | 'ui' | 'system';

export interface IComponentInstallationUsage {
  lastUsedAt?: Date;
  totalCalls: number;
  totalTokens?: number;
}

export interface IComponentInstallation {
  // Sub-document _id is preserved (see schema opts below) so callers can
  // cross-reference a specific component installation across tables.
  _id?: Types.ObjectId;

  componentName: string;
  componentType: ComponentType;

  /**
   * Multi-instance support: `'default'` unless the user has deliberately
   * spun up more than one instance of the same component (e.g. two
   * task-clerk agents in the same pod with different personas).
   */
  instanceId: string;

  status: InstallationStatus;
  errorMessage?: string;

  /**
   * Per-installation config override that supplements manifest defaults.
   * Stored as a Mongoose Map so keys are preserved in write order and
   * round-trip cleanly as plain objects on read.
   */
  config?: Map<string, unknown>;

  /**
   * Projection pointers into runtime tables created by Phase 2 adapters.
   * Example shape:
   *   { agentInstallationId: ObjectId(...), slashCommandId: ObjectId(...) }
   */
  projectionIds?: Map<string, Types.ObjectId>;

  usage: IComponentInstallationUsage;

  createdAt: Date;
  updatedAt: Date;
}

export interface IInstallationAdminPause {
  reason: string;
  at: Date;
  adminId: string;
}

export interface IInstallationPauseAudit {
  action: 'pause' | 'resume';
  installationId: string;
  ownerId: string;
  adminId: string;
  reason: string;
  at: Date;
}

export interface IInstallableInstallation extends Document {
  // Which Installable is installed
  installableId: string; // FK (logical) → Installable.installableId
  installableVersion: string;

  // Where it's installed
  targetType: InstallationTargetType;
  targetId: Types.ObjectId;
  scope: InstallableScope; // replicates Installable.scope for query perf

  // The pod requested by the current claim. It makes a fresh transient legible
  // before a projection exists; an errored or stale inactive projection may
  // safely adopt the retry's pod at its fenced activation write.
  boundPodId?: Types.ObjectId;

  // Install provenance
  installedBy: Types.ObjectId;
  installSource: InstallSource;

  // Component projections
  components: IComponentInstallation[];

  // Granted capability scopes at install time
  grantedScopes: string[];

  // Lifecycle
  status: InstallationStatus;
  /**
   * Derived: true exactly when `status` is in LIVE_INSTALLATION_STATUSES. It
   * exists so the live-target unique index can filter on `live: true`, which
   * FerretDB accepts, instead of `status: {$in}`, which it refuses. Never write
   * it by hand; the hooks below derive it on every Mongoose write path.
   */
  live?: boolean;
  /**
   * Opaque ownership generation for a transient install claim. Every parent
   * owner write includes it in its filter; a stale worker is then a no-op
   * instead of overwriting the winner's lifecycle state or bearer code.
   */
  claimId?: string;
  claimedAt?: Date;
  errorMessage?: string;
  /**
   * Whether `errorMessage` was written for a person. Two kinds of string land
   * in that field — the reconciler's human-authored constants, and
   * `markProjectionFailure`'s raw exception message — and the Connectors page
   * renders them through one branch, so only a flagged message is printed
   * (vera 73848). Set together with the message by the builders below.
   */
  errorMessageUserFacing?: boolean;
  staleSince?: Date;
  /** Canonical pause state; Integration.config.adminPause is its projection. */
  adminPause?: IInstallationAdminPause;
  pauseAudit: IInstallationPauseAudit[];

  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

const ComponentInstallationUsageSchema = new Schema<IComponentInstallationUsage>(
  {
    lastUsedAt: { type: Date },
    totalCalls: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
  },
  { _id: false },
);

const ComponentInstallationSchema = new Schema<IComponentInstallation>(
  {
    componentName: { type: String, required: true },
    componentType: {
      type: String,
      enum: [
        'agent',
        'slash-command',
        'event-handler',
        'scheduled-job',
        'widget',
        'webhook',
        'data-schema',
      ],
      required: true,
    },
    instanceId: { type: String, default: 'default' },
    status: {
      type: String,
      enum: ['active', 'paused', 'uninstalled', 'error', 'stale'],
      default: 'active',
    },
    errorMessage: { type: String },
    config: { type: Map, of: Schema.Types.Mixed },
    projectionIds: { type: Map, of: Schema.Types.ObjectId },
    usage: { type: ComponentInstallationUsageSchema, default: () => ({}) },
  },
  // Keep stable _ids on component installations so legacy runtime tables can
  // cross-reference a specific component projection.
  { _id: true, timestamps: true },
);

// ---------------------------------------------------------------------------
// Top-level schema
// ---------------------------------------------------------------------------

const InstallableInstallationSchema = new Schema<IInstallableInstallation>(
  {
    installableId: { type: String, required: true, lowercase: true },
    installableVersion: { type: String, required: true },

    targetType: {
      type: String,
      enum: ['pod', 'user', 'dm', 'instance'],
      required: true,
    },
    targetId: { type: Schema.Types.ObjectId, required: true },
    scope: {
      type: String,
      enum: ['instance', 'pod', 'user', 'dm'],
      required: true,
    },
    boundPodId: { type: Schema.Types.ObjectId, ref: 'Pod' },

    installedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    installSource: {
      type: String,
      enum: ['marketplace', 'registry', 'direct', 'ui', 'system'],
      required: true,
    },

    components: { type: [ComponentInstallationSchema], default: [] },

    grantedScopes: { type: [String], default: [] },

    status: {
      type: String,
      enum: ['installing', 'activating', 'uninstalling', 'active', 'paused', 'uninstalled', 'error', 'stale'],
      default: 'active',
    },
    // Derived from `status` by the hooks below; see IInstallableInstallation.live.
    live: { type: Boolean },
    claimId: { type: String },
    claimedAt: { type: Date },
    errorMessage: { type: String },
    errorMessageUserFacing: { type: Boolean, default: false },
    staleSince: { type: Date },
    adminPause: {
      reason: { type: String },
      at: { type: Date },
      adminId: { type: String },
    },
    pauseAudit: {
      type: [new Schema<IInstallationPauseAudit>({
        action: { type: String, enum: ['pause', 'resume'], required: true },
        installationId: { type: String, required: true },
        ownerId: { type: String, required: true },
        adminId: { type: String, required: true },
        reason: { type: String, required: true },
        at: { type: Date, required: true },
      }, { _id: false })],
      default: [],
    },
  },
  { timestamps: true },
);

// ---------------------------------------------------------------------------
// Derived `live` flag
// ---------------------------------------------------------------------------

/**
 * The statuses that hold a target's one live installation. `uninstalled` and
 * `stale` rows fall outside: their audit history survives, while a later
 * install gets a new parent/projection instead of resurrecting a historical
 * connector. Retained `error` rows stay inside so retry can claim the same
 * parent and safely reuse its inactive projection.
 */
export const LIVE_INSTALLATION_STATUSES: readonly InstallationStatus[] = [
  'installing', 'activating', 'uninstalling', 'active', 'paused', 'error',
];

export const isLiveInstallationStatus = (status: unknown): boolean => (
  typeof status === 'string'
  && (LIVE_INSTALLATION_STATUSES as readonly string[]).includes(status)
);

const STATUS_DEFAULT: InstallationStatus = 'active';

// Document writes: save(), create(), insertMany() (validation runs per doc).
// pre('save') as well as pre('validate'), so `validateBeforeSave: false`
// cannot skip the derivation.
function deriveLiveOnDocument(this: IInstallableInstallation): void {
  this.live = isLiveInstallationStatus(this.status);
}
InstallableInstallationSchema.pre('validate', deriveLiveOnDocument);
InstallableInstallationSchema.pre('save', deriveLiveOnDocument);

type UpdateDoc = Record<string, unknown> & {
  $set?: Record<string, unknown>;
  $setOnInsert?: Record<string, unknown>;
  $unset?: Record<string, unknown>;
};

const has = (obj: unknown, key: string): boolean => (
  !!obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key)
);

/**
 * The status an upsert inserts when the update never names one: Mongo seeds a
 * plain-equality filter value into the new doc; otherwise Mongoose's
 * setDefaultsOnInsert writes the schema default (unless it is turned off).
 */
const insertedStatusFromFilter = (
  filter: Record<string, unknown> | null,
  options: { setDefaultsOnInsert?: boolean },
): unknown => {
  const condition = filter?.status;
  if (typeof condition === 'string') return condition;
  if (options.setDefaultsOnInsert === false) return undefined;
  return STATUS_DEFAULT;
};

// Query writes. Each derives `live` from whatever the update does to `status`,
// so no call site has to remember the flag:
//   - pipeline update (array): a trailing stage recomputes `live` from the
//     post-update `status`, covering a $cond-computed status and upserts;
//   - `$set.status`, a bare top-level `status`, or `$unset.status`;
//   - `$setOnInsert.status`, or an upsert whose status comes from the filter
//     or the schema default.
// An update that never touches status leaves `live` alone.
// NOT covered (no caller today): Model.bulkWrite and raw Model.collection
// writes, which run no middleware.
function deriveLiveOnQuery(this: mongoose.Query<unknown, unknown>): void {
  const update = this.getUpdate() as UpdateDoc | Array<Record<string, unknown>> | null;
  if (!update) return;
  if (Array.isArray(update)) {
    update.push({
      $set: {
        live: { $in: [{ $ifNull: ['$status', null] }, [...LIVE_INSTALLATION_STATUSES]] },
      },
    });
    this.setUpdate(update as unknown as mongoose.UpdateQuery<unknown>);
    return;
  }

  const options = this.getOptions() as { upsert?: boolean; setDefaultsOnInsert?: boolean };
  let touched = false;
  if (has(update, 'status')) {
    update.live = isLiveInstallationStatus(update.status);
    touched = true;
  }
  if (update.$set && has(update.$set, 'status')) {
    update.$set.live = isLiveInstallationStatus(update.$set.status);
    touched = true;
  }
  if (has(update.$unset, 'status')) {
    update.$set = { ...(update.$set || {}), live: false };
    touched = true;
  }
  if (update.$setOnInsert && has(update.$setOnInsert, 'status')) {
    update.$setOnInsert.live = isLiveInstallationStatus(update.$setOnInsert.status);
    touched = true;
  }
  if (!touched && options.upsert) {
    update.$setOnInsert = {
      ...(update.$setOnInsert || {}),
      live: isLiveInstallationStatus(
        insertedStatusFromFilter(this.getFilter() as Record<string, unknown> | null, options),
      ),
    };
  }
  this.setUpdate(update as mongoose.UpdateQuery<unknown>);
}

// A replacement document carries `status` (or gets the schema default).
function deriveLiveOnReplace(this: mongoose.Query<unknown, unknown>): void {
  const replacement = this.getUpdate() as Record<string, unknown> | null;
  if (!replacement || Array.isArray(replacement)) return;
  replacement.live = isLiveInstallationStatus(
    has(replacement, 'status') ? replacement.status : STATUS_DEFAULT,
  );
  this.setUpdate(replacement as mongoose.UpdateQuery<unknown>);
}

InstallableInstallationSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate'],
  { document: false, query: true },
  deriveLiveOnQuery,
);
InstallableInstallationSchema.pre(
  ['replaceOne', 'findOneAndReplace'],
  { document: false, query: true },
  deriveLiveOnReplace,
);

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

// One live installation of a given Installable per target (which statuses
// count as live: LIVE_INSTALLATION_STATUSES).
//
// The filter is the derived `live: true` because FerretDB's partial indexes
// accept only $eq, $gt(e)/$lt(e), $type, $exists:true and a top-level $and,
// and refuse `$in`. Declared before the legacy index so an index build on
// FerretDB creates it even though the legacy one then fails.
InstallableInstallationSchema.index(
  { installableId: 1, targetType: 1, targetId: 1 },
  {
    unique: true,
    name: 'installable_live_target_unique_v2',
    partialFilterExpression: { live: true },
  },
);

// LEGACY. Keep declared until `backfill-installation-live --verify` reports 0
// on prod, then remove it in a follow-up change (syncIndexes() in
// seed-builtin-connectors drops it once undeclared). It cannot build on
// FerretDB, where the v2 index above is the only guarantee.
InstallableInstallationSchema.index(
  { installableId: 1, targetType: 1, targetId: 1 },
  {
    unique: true,
    name: 'installable_live_target_unique',
    partialFilterExpression: {
      status: { $in: [...LIVE_INSTALLATION_STATUSES] },
    },
  },
);

// "What's installed in this pod/user/dm right now?"
InstallableInstallationSchema.index({ targetType: 1, targetId: 1, status: 1 });

// "What have I installed?"
InstallableInstallationSchema.index({ installedBy: 1 });

// Stale / errored component detection scans.
InstallableInstallationSchema.index({ 'components.status': 1 });

// ---------------------------------------------------------------------------
// Model export (HMR guard)
// ---------------------------------------------------------------------------

const InstallableInstallation: Model<IInstallableInstallation> =
  (mongoose.models.InstallableInstallation as Model<IInstallableInstallation>) ||
  mongoose.model<IInstallableInstallation>(
    'InstallableInstallation',
    InstallableInstallationSchema,
  );

export default InstallableInstallation;
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
