/**
 * Runtime hook ingress policy.
 *
 * Hooks are deliberately a thin adapter around the work-claim ledger.  The
 * kernel remains advisory (ADR-028 D7); only a PreToolUse request for a path
 * covered by another seat's active claim is denied.  The service does not
 * retain hook payloads or write tool_input to logs.
 */

const HookLedgerEvent = require('../models/HookLedgerEvent');

export const HOOK_EVENT_TYPES = ['PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop'] as const;
export type HookEventType = typeof HOOK_EVENT_TYPES[number];

export interface ActiveWorkClaim {
  claimId?: string;
  agentId?: string;
  agentUserId?: string;
  ownerId?: string;
  agentName?: string;
  claimedBy?: string;
  instanceId?: string;
  paths?: string[];
  expiresAt?: Date | string | number;
}

export interface HookDecision {
  permissionDecision: 'allow' | 'deny';
  eventId: string;
  event: HookEventType;
  reason?: string;
  holder?: string;
  replayed?: boolean;
}

type ClaimProvider = (podId: string) => Promise<ActiveWorkClaim[]>;
type LedgerKey = { podId: string; agentId: string; eventId: string };
type LedgerStore = {
  find: (key: LedgerKey) => Promise<any | null>;
  insertOrGet: (key: LedgerKey, value: Record<string, unknown>) => Promise<any | null>;
  clear?: () => Promise<void>;
};

// The D1 work-claim store is still being built.  Keeping the provider behind
// this seam lets the endpoint ship now and lets the ledger become durable
// without changing the public hook contract.  Tests and the ledger adapter can
// replace it; the safe default is no claim, which preserves D7.
let claimProvider: ClaimProvider = async () => [];
let injectedLedgerStore: LedgerStore | null = null;

const mongoLedgerStore: LedgerStore = {
  async find(key) {
    return HookLedgerEvent.findOne(key).lean();
  },
  async insertOrGet(key, value) {
    return HookLedgerEvent.findOneAndUpdate(
      key,
      { $setOnInsert: value },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
  },
  async clear() {
    await HookLedgerEvent.deleteMany({});
  },
};

const getLedgerStore = (): LedgerStore | null => {
  if (injectedLedgerStore) return injectedLedgerStore;
  // Mongoose buffers operations while disconnected for 10 seconds by
  // default.  A hook must not inherit that stall; treat an unavailable ledger
  // as the ruled fail-open path instead.
  return HookLedgerEvent?.db?.readyState === 1 ? mongoLedgerStore : null;
};

export const setActiveClaimProvider = (provider: ClaimProvider): void => {
  claimProvider = provider;
};

export const resetActiveClaimProvider = (): void => {
  claimProvider = async () => [];
};

export const setHookLedgerStore = (store: LedgerStore | null): void => {
  injectedLedgerStore = store;
};

export const resetHookReplay = async (): Promise<void> => {
  try { await getLedgerStore()?.clear?.(); } catch { /* test/db cleanup is best effort */ }
};

const normalize = (value: unknown): string => String(value || '').trim().toLowerCase();

export const isHookEventType = (value: unknown): value is HookEventType => (
  typeof value === 'string' && (HOOK_EVENT_TYPES as readonly string[]).includes(value)
);

/**
 * Normalize the repo-relative path contract emitted by the CLI.  The server
 * intentionally performs no filesystem access: the caller resolves symlinks
 * on its own checkout, and the ingress only accepts safe POSIX path strings.
 */
export const resolvePathWithinRoot = (value: unknown, _rootDir?: string): string | null => {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) return null;
  const raw = value.trim();
  // POSIX paths are the wire format.  Backslashes and drive prefixes are
  // rejected rather than interpreted differently by another host OS.
  if (raw.includes('\\') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return null;
  const segments = raw.split('/');
  if (segments.some((segment) => segment === '..')) return null;
  const normalized = segments.filter((segment) => segment && segment !== '.').join('/');
  return normalized || '.';
};

const asPathValues = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return [];
};

/** Extract only path-shaped fields; command text is intentionally not parsed. */
export const extractToolPaths = (payload: any): string[] => {
  const declared = asPathValues(payload?.paths || payload?.resolvedPaths);
  return Array.from(new Set(
    declared
      .map((value) => resolvePathWithinRoot(value))
      .filter((value): value is string => Boolean(value)),
  ));
};

const claimOwnerId = (claim: ActiveWorkClaim): string => normalize(
  claim.agentId || claim.agentUserId || claim.ownerId,
);

const claimHolderLabel = (claim: ActiveWorkClaim): string => String(
  claim.agentName || claim.claimedBy || claim.agentId || claim.agentUserId || 'another agent',
);

const claimIsActive = (claim: ActiveWorkClaim, now = Date.now()): boolean => {
  if (!claim.expiresAt) return true;
  const expiry = new Date(claim.expiresAt).getTime();
  return Number.isFinite(expiry) && expiry > now;
};

const withinRoot = (candidate: string, root: string): boolean => (
  root === '.' || candidate === root || candidate.startsWith(`${root}/`)
);

const claimCoversPath = (claimPath: string, targetPath: string): boolean => {
  const claimResolved = resolvePathWithinRoot(claimPath);
  const targetResolved = resolvePathWithinRoot(targetPath);
  return Boolean(claimResolved && targetResolved && withinRoot(targetResolved, claimResolved));
};

export const evaluatePreToolUse = async ({
  podId,
  agentName,
  event,
  eventId,
  payload,
  agentId,
  provider = claimProvider,
}: {
  podId: string;
  agentName: string;
  agentId?: string;
  event: HookEventType;
  eventId: string;
  payload: any;
  rootDir?: string;
  provider?: ClaimProvider;
}): Promise<{ decision: HookDecision; statusCode: number }> => {
  const base: HookDecision = {
    permissionDecision: 'allow', event, eventId,
  };
  if (event !== 'PreToolUse') return { decision: base, statusCode: 200 };

  const paths = extractToolPaths(payload);
  // A hook with no path-shaped input cannot prove a work-area conflict.  D7
  // says the kernel must not turn an absent claim into a blocked write.
  if (paths.length === 0) return { decision: base, statusCode: 200 };

  let claims: ActiveWorkClaim[];
  try {
    claims = await provider(podId);
  } catch {
    // D7 is fail-open at the runtime edge: a missing/temporarily unavailable
    // ledger is not evidence of a foreign claim and must not stall a tool.
    return {
      decision: { ...base, reason: 'claim_lookup_unavailable' },
      statusCode: 200,
    };
  }

  const callerId = normalize(agentId || agentName);
  const active = claims.filter((claim) => claimIsActive(claim));
  const ownCoverage = active.some((claim) => (
    claimOwnerId(claim) === callerId
      && (claim.paths || []).some((claimPath) => paths.some((target) => claimCoversPath(claimPath, target)))
  ));
  if (ownCoverage) return { decision: base, statusCode: 200 };

  const conflict = active.find((claim) => {
    const owner = claimOwnerId(claim);
    return owner && owner !== callerId
      && (claim.paths || []).some((claimPath) => paths.some((target) => claimCoversPath(claimPath, target)));
  });
  if (!conflict) return { decision: base, statusCode: 200 };

  const holder = claimHolderLabel(conflict);
  return {
    decision: {
      ...base,
      permissionDecision: 'deny',
      holder,
      reason: `path is under ${holder}'s active claim; call commonly_claim_task before proceeding`,
    },
    statusCode: 200,
  };
};

export const processHookEvent = async (options: {
  podId: string;
  agentId?: string;
  agentName: string;
  event: HookEventType;
  eventId: string;
  payload: any;
  rootDir?: string;
  provider?: ClaimProvider;
}): Promise<{ response: HookDecision; statusCode: number; replayed: boolean }> => {
  const key = {
    podId: String(options.podId),
    agentId: normalize(options.agentId || options.agentName),
    eventId: String(options.eventId),
  };
  const ledger = getLedgerStore();
  try {
    const existing = await ledger?.find(key);
    if (existing) {
      return {
        response: {
          permissionDecision: existing.permissionDecision,
          eventId: existing.eventId,
          event: existing.event,
          ...(existing.reason ? { reason: existing.reason } : {}),
          ...(existing.holder ? { holder: existing.holder } : {}),
          replayed: true,
        },
        statusCode: 200,
        replayed: true,
      };
    }
  } catch {
    // D7: a ledger read failure is not evidence of a foreign claim. Continue
    // to evaluate and attempt the append; the caller remains fail-open.
  }

  const result = await evaluatePreToolUse(options);
  const response = { ...result.decision, replayed: false };
  try {
    const inserted = await ledger?.insertOrGet(key, {
      ...key,
      agentName: normalize(options.agentName),
      event: options.event,
      ...(typeof options.payload?.tool === 'string' ? { tool: options.payload.tool } : {}),
      ...(typeof options.payload?.argsDigest === 'string' ? { argsDigest: options.payload.argsDigest } : {}),
      paths: extractToolPaths(options.payload),
      permissionDecision: response.permissionDecision,
      ...(response.reason ? { reason: response.reason } : {}),
      ...(response.holder ? { holder: response.holder } : {}),
    });
    if (inserted && String(inserted.eventId) === String(options.eventId)
      && String(inserted.agentId || inserted.agentName) === normalize(options.agentId || options.agentName)
      && inserted.permissionDecision !== response.permissionDecision) {
      return {
        response: {
          permissionDecision: inserted.permissionDecision,
          eventId: inserted.eventId,
          event: inserted.event,
          ...(inserted.reason ? { reason: inserted.reason } : {}),
          ...(inserted.holder ? { holder: inserted.holder } : {}),
          replayed: true,
        },
        statusCode: 200,
        replayed: true,
      };
    }
  } catch {
    // Fail-open if the append races or the ledger is temporarily unavailable.
  }
  return { response, statusCode: 200, replayed: false };
};

export const _test = { claimIsActive, withinRoot };
