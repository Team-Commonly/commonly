/**
 * Runtime hook ingress policy.
 *
 * Hooks are deliberately a thin adapter around the work-claim ledger.  The
 * kernel remains advisory (ADR-028 D7); only a PreToolUse request for a path
 * covered by another seat's active claim is denied.  The service does not
 * retain hook payloads or write tool_input to logs.
 */

import fs from 'fs';
import path from 'path';

const HookLedgerEvent = require('../models/HookLedgerEvent');

export const HOOK_EVENT_TYPES = ['PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop'] as const;
export type HookEventType = typeof HOOK_EVENT_TYPES[number];

export interface ActiveWorkClaim {
  claimId?: string;
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
type LedgerKey = { podId: string; agentName: string; eventId: string };
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

const withinRoot = (candidate: string, root: string): boolean => (
  candidate === root || candidate.startsWith(`${root}${path.sep}`)
);

/**
 * Resolve a path without allowing `..`, absolute-path, or symlink escapes.
 * Non-existent files are resolved through their nearest existing parent so a
 * new file can still be checked against a claim.
 */
export const resolvePathWithinRoot = (value: unknown, rootDir = process.env.COMMONLY_HOOK_REPO_ROOT || process.cwd()): string | null => {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) return null;
  let root: string;
  try {
    root = fs.realpathSync.native(path.resolve(rootDir));
  } catch {
    root = path.resolve(rootDir);
  }

  const raw = value.trim();
  const absolute = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(root, raw);
  if (!withinRoot(absolute, root)) return null;

  let current = absolute;
  const suffix: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    suffix.unshift(path.basename(current));
    current = parent;
  }

  let resolved: string;
  try {
    resolved = fs.realpathSync.native(current);
  } catch {
    resolved = path.resolve(current);
  }
  resolved = path.resolve(resolved, ...suffix);
  return withinRoot(resolved, root) ? resolved : null;
};

const asPathValues = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return [];
};

/** Extract only path-shaped fields; command text is intentionally not parsed. */
export const extractToolPaths = (payload: any): string[] => {
  const declared = asPathValues(payload?.paths || payload?.resolvedPaths);
  if (declared.length > 0) return Array.from(new Set(declared.map((value) => value.trim()).filter(Boolean)));
  const input = payload?.tool_input || payload?.data?.tool_input || {};
  const values = [
    ...asPathValues(input.path),
    ...asPathValues(input.file_path),
    ...asPathValues(input.filePath),
    ...asPathValues(input.target_file),
    ...asPathValues(input.paths),
  ];
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
};

const claimOwner = (claim: ActiveWorkClaim): string => normalize(claim.agentName || claim.claimedBy);

const claimIsActive = (claim: ActiveWorkClaim, now = Date.now()): boolean => {
  if (!claim.expiresAt) return true;
  const expiry = new Date(claim.expiresAt).getTime();
  return Number.isFinite(expiry) && expiry > now;
};

const claimCoversPath = (claimPath: string, targetPath: string, rootDir: string): boolean => {
  const claimResolved = resolvePathWithinRoot(claimPath, rootDir);
  return Boolean(claimResolved && withinRoot(targetPath, claimResolved));
};

export const evaluatePreToolUse = async ({
  podId,
  agentName,
  event,
  eventId,
  payload,
  rootDir = process.env.COMMONLY_HOOK_REPO_ROOT || process.cwd(),
  provider = claimProvider,
}: {
  podId: string;
  agentName: string;
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

  const paths = extractToolPaths(payload)
    .map((candidate) => resolvePathWithinRoot(candidate, rootDir))
    .filter((candidate): candidate is string => Boolean(candidate));
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

  const caller = normalize(agentName);
  const active = claims.filter((claim) => claimIsActive(claim));
  const ownCoverage = active.some((claim) => (
    claimOwner(claim) === caller
    && (claim.paths || []).some((claimPath) => paths.some((target) => claimCoversPath(claimPath, target, rootDir)))
  ));
  if (ownCoverage) return { decision: base, statusCode: 200 };

  const conflict = active.find((claim) => {
    const owner = claimOwner(claim);
    return owner && owner !== caller
      && (claim.paths || []).some((claimPath) => paths.some((target) => claimCoversPath(claimPath, target, rootDir)));
  });
  if (!conflict) return { decision: base, statusCode: 200 };

  const holder = claimOwner(conflict);
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
  agentName: string;
  event: HookEventType;
  eventId: string;
  payload: any;
  rootDir?: string;
  provider?: ClaimProvider;
}): Promise<{ response: HookDecision; statusCode: number; replayed: boolean }> => {
  const key = {
    podId: String(options.podId),
    agentName: normalize(options.agentName),
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
      event: options.event,
      ...(typeof options.payload?.tool === 'string' ? { tool: options.payload.tool } : {}),
      ...(typeof options.payload?.argsDigest === 'string' ? { argsDigest: options.payload.argsDigest } : {}),
      paths: extractToolPaths(options.payload),
      permissionDecision: response.permissionDecision,
      ...(response.reason ? { reason: response.reason } : {}),
      ...(response.holder ? { holder: response.holder } : {}),
    });
    if (inserted && String(inserted.eventId) === String(options.eventId)
      && String(inserted.agentName) === normalize(options.agentName)
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
