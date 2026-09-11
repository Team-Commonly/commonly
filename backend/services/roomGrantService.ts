import { randomUUID } from 'crypto';
import RoomGrant, {
  IRoomGrant,
  IRoomGrantBudget,
  RoomGrantTargetKind,
  RoomGrantWriteMode,
} from '../models/RoomGrant';

export interface RoomGrantCreateInput {
  grantId?: string;
  connectionId: string;
  installationId: string;
  target: { kind: RoomGrantTargetKind; id: string };
  tools: string[];
  writeMode: RoomGrantWriteMode;
  budget?: IRoomGrantBudget;
  audience: string[];
  expiresAt: Date | string | number;
  brokerId: string;
  parentGrantId?: string;
}

export interface RoomGrantAttenuationInput {
  parentGrantId: string;
  tools?: string[];
  writeMode?: RoomGrantWriteMode;
  budget?: IRoomGrantBudget;
  audience?: string[];
  expiresAt?: Date | string | number;
  /** Accepted for API compatibility but never copied into the row. */
  grantId?: string;
}

export interface GrantUsabilityOptions {
  grant?: IRoomGrant | Record<string, unknown>;
  grantId?: string;
  agentUserId?: string;
  currentMemberIds?: string[];
  tool?: string;
  requiredWriteMode?: RoomGrantWriteMode;
}

export class RoomGrantError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, statusCode = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = 'RoomGrantError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

const WRITE_MODE_RANK: Record<RoomGrantWriteMode, number> = {
  read: 0,
  'write-with-confirm': 1,
  write: 2,
};

const asId = (value: unknown, field: string): string => {
  const id = String(value ?? '').trim();
  if (!id) throw new RoomGrantError('invalid_grant', `${field} is required`);
  return id;
};

const uniqueStrings = (values: unknown, field: string): string[] => {
  if (!Array.isArray(values)) throw new RoomGrantError('invalid_grant', `${field} must be an array`);
  return Array.from(new Set(values.map((value) => asId(value, field))));
};

const asDate = (value: unknown, field: string): Date => {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value as string | number);
  if (Number.isNaN(date.getTime())) throw new RoomGrantError('invalid_grant', `${field} must be a valid date`);
  return date;
};

const validateWriteMode = (value: unknown): RoomGrantWriteMode => {
  if (value !== 'read' && value !== 'write' && value !== 'write-with-confirm') {
    throw new RoomGrantError('invalid_write_mode', 'writeMode must be read, write, or write-with-confirm');
  }
  return value;
};

const validateTargetKind = (value: unknown): RoomGrantTargetKind => {
  if (value !== 'pod' && value !== 'seat') {
    throw new RoomGrantError('invalid_target', 'target.kind must be pod or seat');
  }
  return value;
};

const normalizeBudget = (budget: IRoomGrantBudget | undefined): IRoomGrantBudget | undefined => {
  if (budget === undefined || budget === null) return undefined;
  if (typeof budget !== 'object') throw new RoomGrantError('invalid_budget', 'budget must be an object');
  const result: IRoomGrantBudget = {};
  if (budget.calls !== undefined) {
    if (!Number.isInteger(budget.calls) || budget.calls < 0) {
      throw new RoomGrantError('invalid_budget', 'budget.calls must be a non-negative integer');
    }
    result.calls = budget.calls;
  }
  if (budget.windowMs !== undefined) {
    if (!Number.isInteger(budget.windowMs) || budget.windowMs < 1) {
      throw new RoomGrantError('invalid_budget', 'budget.windowMs must be a positive integer');
    }
    result.windowMs = budget.windowMs;
  }
  return result;
};

const budgetFieldIsNarrower = (
  child: number | undefined,
  parent: number | undefined,
  field: string,
): boolean => {
  // An omitted parent limit is unlimited. A child may introduce a limit, but
  // may not turn a finite parent limit into an unlimited one.
  if (parent === undefined) return true;
  if (child === undefined) {
    throw new RoomGrantError('grant_not_attenuated', `child budget.${field} cannot be wider than its parent`);
  }
  return child <= parent;
};

const assertBudgetAttenuated = (
  child: IRoomGrantBudget | undefined,
  parent: IRoomGrantBudget | undefined,
): void => {
  if (!parent && !child) return;
  if (!budgetFieldIsNarrower(child?.calls, parent?.calls, 'calls')) {
    throw new RoomGrantError('grant_not_attenuated', 'child budget.calls cannot exceed its parent');
  }
  if (!budgetFieldIsNarrower(child?.windowMs, parent?.windowMs, 'windowMs')) {
    throw new RoomGrantError('grant_not_attenuated', 'child budget.windowMs cannot exceed its parent');
  }
};

const mergeBudget = (
  parent: IRoomGrantBudget | undefined,
  requested: IRoomGrantBudget | undefined,
): IRoomGrantBudget | undefined => {
  if (requested === undefined) {
    if (!parent) return undefined;
    return normalizeBudget({ calls: parent.calls, windowMs: parent.windowMs });
  }
  return normalizeBudget({
    calls: requested.calls === undefined ? parent?.calls : requested.calls,
    windowMs: requested.windowMs === undefined ? parent?.windowMs : requested.windowMs,
  });
};

const readGrantValue = <T>(grant: IRoomGrant | Record<string, unknown>, key: string): T =>
  (grant as Record<string, unknown>)[key] as T;

const grantIsRevoked = (grant: IRoomGrant | Record<string, unknown>): boolean => {
  const revokedAt = readGrantValue<unknown>(grant, 'revokedAt');
  return revokedAt !== undefined && revokedAt !== null;
};

const grantIsExpired = (grant: IRoomGrant | Record<string, unknown>, now = new Date()): boolean => {
  const expiresAt = readGrantValue<unknown>(grant, 'expiresAt');
  return !expiresAt || asDate(expiresAt, 'expiresAt').getTime() <= now.getTime();
};

export const effectiveAudience = (
  grant: Pick<IRoomGrant, 'audience'> | { audience?: string[] },
  currentMemberIds: string[],
): string[] => {
  const current = new Set(currentMemberIds.map((id) => String(id)));
  return Array.from(new Set((grant.audience || []).map(String))).filter((id) => current.has(id));
};

export const mintGrant = async (input: RoomGrantCreateInput): Promise<IRoomGrant> => {
  if (input.expiresAt === undefined || input.expiresAt === null || input.expiresAt === '') {
    throw new RoomGrantError('missing_expiry', 'expiresAt is required');
  }
  const expiresAt = asDate(input.expiresAt, 'expiresAt');
  if (expiresAt.getTime() <= Date.now()) {
    throw new RoomGrantError('invalid_expiry', 'expiresAt must be in the future');
  }
  const budget = normalizeBudget(input.budget);
  const grant = await RoomGrant.create({
    grantId: input.grantId ? asId(input.grantId, 'grantId') : `grant_${randomUUID()}`,
    connectionId: asId(input.connectionId, 'connectionId'),
    installationId: asId(input.installationId, 'installationId'),
    target: {
      kind: validateTargetKind(input.target?.kind),
      id: asId(input.target?.id, 'target.id'),
    },
    tools: uniqueStrings(input.tools, 'tools'),
    writeMode: validateWriteMode(input.writeMode),
    budget,
    audience: uniqueStrings(input.audience, 'audience'),
    expiresAt,
    parentGrantId: input.parentGrantId ? asId(input.parentGrantId, 'parentGrantId') : undefined,
    brokerId: asId(input.brokerId, 'brokerId'),
  });
  return grant;
};

// The public name mirrors the ADR and makes the route's intent explicit.
export const createGrant = mintGrant;

export const attenuateGrant = async (input: RoomGrantAttenuationInput): Promise<IRoomGrant> => {
  const parentGrantId = asId(input.parentGrantId, 'parentGrantId');
  // Load the parent by its server-side id. No parent capabilities are accepted
  // from the request body, which is the critical attenuation boundary.
  const parent = await RoomGrant.findOne({ grantId: parentGrantId });
  if (!parent) throw new RoomGrantError('grant_not_found', 'parent grant not found', 404);
  if (grantIsRevoked(parent)) throw new RoomGrantError('grant_revoked', 'parent grant is revoked', 403);
  if (grantIsExpired(parent)) throw new RoomGrantError('grant_expired', 'parent grant is expired', 403);
  const parentExpiry = asDate(parent.expiresAt, 'expiresAt');

  const tools = input.tools === undefined ? [...parent.tools] : uniqueStrings(input.tools, 'tools');
  const parentTools = new Set(parent.tools.map(String));
  const outsideTools = tools.filter((tool) => !parentTools.has(tool));
  if (outsideTools.length) {
    throw new RoomGrantError(
      'grant_not_attenuated',
      `child tools must be a subset of parent tools: ${outsideTools.join(', ')}`,
      400,
      { tools: outsideTools },
    );
  }

  const writeMode = input.writeMode === undefined ? parent.writeMode : validateWriteMode(input.writeMode);
  if (WRITE_MODE_RANK[writeMode] > WRITE_MODE_RANK[parent.writeMode]) {
    throw new RoomGrantError('grant_not_attenuated', 'child writeMode cannot be stronger than its parent');
  }

  const requestedBudget = normalizeBudget(input.budget);
  const budget = mergeBudget(parent.budget, requestedBudget);
  assertBudgetAttenuated(budget, parent.budget);

  const audience = input.audience === undefined
    ? [...parent.audience]
    : uniqueStrings(input.audience, 'audience');
  const parentAudience = new Set(parent.audience.map(String));
  const outsideAudience = audience.filter((id) => !parentAudience.has(id));
  if (outsideAudience.length) {
    throw new RoomGrantError('grant_not_attenuated', 'child audience must be a subset of parent audience', 400, {
      audience: outsideAudience,
    });
  }

  const requestedExpiry = input.expiresAt === undefined
    ? new Date(parentExpiry)
    : asDate(input.expiresAt, 'expiresAt');
  // The plan deliberately clamps a later child expiry rather than rejecting it.
  const expiresAt = requestedExpiry.getTime() > parentExpiry.getTime()
    ? new Date(parentExpiry)
    : requestedExpiry;
  if (expiresAt.getTime() <= Date.now()) {
    throw new RoomGrantError('invalid_expiry', 'expiresAt must be in the future');
  }

  return mintGrant({
    connectionId: parent.connectionId,
    installationId: parent.installationId,
    target: { kind: parent.target.kind, id: parent.target.id },
    tools,
    writeMode,
    budget,
    audience,
    expiresAt,
    parentGrantId,
    brokerId: parent.brokerId,
  });
};

export const revokeGrant = async (grantId: string): Promise<number> => {
  const id = asId(grantId, 'grantId');
  const root = await RoomGrant.findOne({ grantId: id }).select('grantId').lean();
  if (!root) throw new RoomGrantError('grant_not_found', 'grant not found', 404);
  return RoomGrant.revokeCascade(id);
};

export const assertGrantUsable = async (
  options: GrantUsabilityOptions,
): Promise<IRoomGrant | Record<string, unknown>> => {
  const grant = options.grant || (options.grantId
    ? await RoomGrant.findOne({ grantId: asId(options.grantId, 'grantId') })
    : null);
  if (!grant) throw new RoomGrantError('grant_not_found', 'grant not found', 404);
  if (grantIsRevoked(grant)) throw new RoomGrantError('grant_revoked', 'grant is revoked', 403);
  if (grantIsExpired(grant)) throw new RoomGrantError('grant_expired', 'grant is expired', 403);

  if (options.currentMemberIds && options.agentUserId) {
    const audience = effectiveAudience(grant as Pick<IRoomGrant, 'audience'>, options.currentMemberIds);
    if (!audience.includes(String(options.agentUserId))) {
      throw new RoomGrantError('not_in_audience', 'agent is not in the grant audience', 403);
    }
  }

  if (options.tool !== undefined) {
    const tools = (readGrantValue<string[]>(grant, 'tools') || []).map(String);
    if (!tools.includes(options.tool)) {
      throw new RoomGrantError('tool_not_allowed', `tool is not allowed by this grant: ${options.tool}`, 403);
    }
  }
  if (options.requiredWriteMode !== undefined) {
    const actualMode = readGrantValue<RoomGrantWriteMode>(grant, 'writeMode');
    if (WRITE_MODE_RANK[options.requiredWriteMode] > WRITE_MODE_RANK[actualMode]) {
      throw new RoomGrantError('write_mode_not_allowed', 'tool requires a stronger write mode than this grant', 403);
    }
  }
  return grant;
};

export const getEffectiveAudience = effectiveAudience;

export default {
  mintGrant,
  createGrant,
  attenuateGrant,
  revokeGrant,
  assertGrantUsable,
  effectiveAudience,
  getEffectiveAudience,
  RoomGrantError,
};

// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"];
Object.assign(module.exports, exports);
