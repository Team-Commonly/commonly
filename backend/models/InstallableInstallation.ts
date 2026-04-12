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
  | 'active'
  | 'paused'
  | 'uninstalled'
  | 'error'
  | 'stale';

export type InstallSource = 'marketplace' | 'registry' | 'direct' | 'system';

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

export interface IInstallableInstallation extends Document {
  // Which Installable is installed
  installableId: string; // FK (logical) → Installable.installableId
  installableVersion: string;

  // Where it's installed
  targetType: InstallationTargetType;
  targetId: Types.ObjectId;
  scope: InstallableScope; // replicates Installable.scope for query perf

  // Install provenance
  installedBy: Types.ObjectId;
  installSource: InstallSource;

  // Component projections
  components: IComponentInstallation[];

  // Granted capability scopes at install time
  grantedScopes: string[];

  // Lifecycle
  status: InstallationStatus;
  errorMessage?: string;
  staleSince?: Date;

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

    installedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    installSource: {
      type: String,
      enum: ['marketplace', 'registry', 'direct', 'system'],
      required: true,
    },

    components: { type: [ComponentInstallationSchema], default: [] },

    grantedScopes: { type: [String], default: [] },

    status: {
      type: String,
      enum: ['active', 'paused', 'uninstalled', 'error', 'stale'],
      default: 'active',
    },
    errorMessage: { type: String },
    staleSince: { type: Date },
  },
  { timestamps: true },
);

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

// One installation of a given Installable per target.
InstallableInstallationSchema.index(
  { installableId: 1, targetType: 1, targetId: 1 },
  { unique: true },
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
