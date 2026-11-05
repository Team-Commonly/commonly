// Who may bind a pod to an external chat surface (F143, Cofounder 11-04).
//
// One rule, in one place, for every chat bridge:
//   - a SHARED surface (a Slack channel, a Discord guild channel, a Telegram
//     group, supergroup or channel, a GroupMe group) is read by people outside the pod, so
//     binding one takes authority over the POD: its creator (still a listed
//     member) or an instance admin (`User.role === 'admin'`). Plain membership
//     is not enough;
//   - a PRIVATE 1:1 chat with the bot is read only by the person who bound it,
//     so it stays member-level. Membership itself is the caller's own check
//     (`isConnectorTargetPod`); this rule only adds the shared-surface clause.
//
// Each platform declares its audience below. It is the same knowledge the
// bridges' `isRelayableIntegration` encodes (Telegram relays only `private`,
// Slack only `im`), kept here rather than on the relay adapters so the bind
// paths can read it without loading a bridge. `chatRelayIntegrationTypes()`
// must be a subset of these keys; a unit test holds that.
//
// Fail closed: an unknown type, or a chat type the declaration does not name as
// private, is a shared surface.

// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { isListedPodMember } = require('../../utils/isPodMember');

export type SurfaceAudience = 'private-1to1' | 'shared-surface';

type SurfaceConfig = Record<string, unknown>;

export interface SurfaceBindDeclaration {
  /** Who can read the chat this config names. */
  audience: (config: SurfaceConfig) => SurfaceAudience;
  /**
   * Where the surface is chosen. `request`: the create request names it, so
   * creating the row is the bind. `redemption`: a code is redeemed in the chat
   * itself (Telegram), so a row with no chat yet has nothing to judge and the
   * rule runs when the code is redeemed.
   */
  chosenAt: 'request' | 'redemption';
  /** Config keys that select the surface; changing one on a live row is a retarget. */
  surfaceFields: string[];
}

export const surfaceBindDeclarations: Record<string, SurfaceBindDeclaration> = {
  telegram: {
    audience: (config) => (config.chatType === 'private' ? 'private-1to1' : 'shared-surface'),
    chosenAt: 'redemption',
    surfaceFields: ['chatId', 'chatType'],
  },
  // The OAuth bind (routes/installables.ts) only ever writes the installer's
  // own DM (`im`). A legacy per-row connector names a `channelId`, and the
  // legacy webhook route buffers that channel into the pod, so a channel id
  // makes the row shared even beside an `im`.
  slack: {
    audience: (config) => (config.chatType === 'im' && !config.channelId ? 'private-1to1' : 'shared-surface'),
    chosenAt: 'request',
    surfaceFields: ['chatId', 'chatType', 'channelId'],
  },
  // Every Discord connector is a guild channel.
  discord: {
    audience: () => 'shared-surface',
    chosenAt: 'request',
    surfaceFields: ['serverId', 'channelId'],
  },
  // A GroupMe connector bridges a group chat. `botId` counts as a surface field
  // because the bot is what posts, and a bot belongs to one group.
  groupme: {
    audience: () => 'shared-surface',
    chosenAt: 'request',
    surfaceFields: ['groupId', 'botId'],
  },
};

export const SHARED_SURFACE_REFUSAL = {
  code: 'shared_surface_needs_pod_authority',
  message: 'Only the pod creator can connect a shared channel to this pod',
} as const;

export class SurfaceBindRefusedError extends Error {
  readonly status = 403;

  readonly body = { ...SHARED_SURFACE_REFUSAL };

  constructor() {
    super(SHARED_SURFACE_REFUSAL.message);
    this.name = 'SurfaceBindRefusedError';
  }
}

/** Types whose binds this rule governs. */
export const isSurfaceBindType = (type: unknown): boolean => (
  typeof type === 'string' && Object.prototype.hasOwnProperty.call(surfaceBindDeclarations, type)
);

const declarationFor = (type: unknown): SurfaceBindDeclaration | null => (
  isSurfaceBindType(type) ? surfaceBindDeclarations[type as string] : null
);

/** Who can read the surface. Unknown type or chat type: shared. */
export const surfaceAudienceOf = (type: unknown, config: SurfaceConfig | null | undefined): SurfaceAudience => {
  const declaration = declarationFor(type);
  if (!declaration) return 'shared-surface';
  return declaration.audience(config || {}) === 'private-1to1' ? 'private-1to1' : 'shared-surface';
};

/** True when this write changes which external chat a live row points at. */
export const retargetsSurface = (
  type: unknown,
  before: SurfaceConfig | null | undefined,
  after: SurfaceConfig | null | undefined,
): boolean => {
  const fields = declarationFor(type)?.surfaceFields;
  // Unknown type: any config write could be a retarget.
  if (!fields) return true;
  return fields.some((field) => String(before?.[field] ?? '') !== String(after?.[field] ?? ''));
};

const idOf = (value: unknown): string => {
  if (!value) return '';
  const nested = (value as { _id?: unknown })._id;
  return String(nested ?? value);
};

/** The pod's creator, still a listed member (TASK-168), or an instance admin. */
export const hasPodAuthority = (
  user: { _id?: unknown; id?: unknown; role?: string } | null | undefined,
  pod: { createdBy?: unknown; members?: unknown[] } | null | undefined,
): boolean => {
  if (!user || !pod) return false;
  if (user.role === 'admin') return true;
  const userId = idOf(user._id ?? user.id);
  return !!userId && idOf(pod.createdBy) === userId && isListedPodMember(pod, userId);
};

/** Pure form of the rule, for a caller that already holds the user document. */
export const canBindSurface = ({
  user, pod, type, config,
}: {
  user: { _id?: unknown; id?: unknown; role?: string } | null | undefined;
  pod: { createdBy?: unknown; members?: unknown[] } | null | undefined;
  type: unknown;
  config: SurfaceConfig | null | undefined;
}): boolean => {
  const declaration = declarationFor(type);
  // No chat chosen yet: nothing to judge until the code is redeemed.
  if (declaration?.chosenAt === 'redemption' && !config?.chatId) return true;
  if (surfaceAudienceOf(type, config) === 'private-1to1') return true;
  return hasPodAuthority(user, pod);
};

/**
 * Throws `SurfaceBindRefusedError` (403) when `userId` may not bind `pod` to
 * the surface `config` names. The user is read from the database: the auth
 * middleware sets `role` only on the JWT branch.
 */
export const assertCanBindSurface = async ({
  userId, pod, type, config,
}: {
  userId: unknown;
  pod: { createdBy?: unknown; members?: unknown[] } | null | undefined;
  type: unknown;
  config: SurfaceConfig | null | undefined;
}): Promise<void> => {
  // Answer without a lookup when the audience settles it.
  if (canBindSurface({
    user: null, pod, type, config,
  })) return;
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const User = require('../../models/User');
  const user = userId ? await User.findById(String(userId)) as { _id?: unknown; role?: string } | null : null;
  if (!canBindSurface({
    user: user ? { _id: user._id ?? userId, role: user.role } : null, pod, type, config,
  })) throw new SurfaceBindRefusedError();
};
