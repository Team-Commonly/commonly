import mongoose from 'mongoose';
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const Task = require('../models/Task');
// eslint-disable-next-line global-require
const User = require('../models/User');

export interface PodFocusInput {
  goal: string;
  scope: string;
  ownerUserId: string;
  nextTaskIds: string[];
}

export interface PodFocusTaskRead {
  taskId: string;
  available: boolean;
  title: string | null;
  status: string | null;
  assignee: string | null;
  updatedAt: string | null;
}

export interface PodFocusRead {
  podId: string;
  revision: number;
  focus: null | {
    goal: string;
    scope: string;
    owner: { userId: string; label: string | null; available: boolean };
    nextTasks: PodFocusTaskRead[];
    updatedAt: string;
    updatedBy: { userId: string; label: string | null };
  };
}

export interface PodFocusError extends Error {
  code: string;
  status: number;
  fields?: Record<string, string>;
}

const MAX_GOAL = 240;
const MAX_SCOPE = 2000;
const MAX_TASK_REFS = 10;
const MAX_TASK_ID = 128;

const fail = (code: string, message: string, status: number, fields?: Record<string, string>): PodFocusError => {
  const error = new Error(message) as PodFocusError;
  error.code = code;
  error.status = status;
  error.fields = fields;
  return error;
};

const idString = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
};

const codePointLength = (value: string): number => Array.from(value).length;

const dateString = (value: unknown): string => {
  const date = value instanceof Date ? value : new Date(value as string | number);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
};

const labelFor = (user: Record<string, unknown> | null): string | null => {
  if (!user) return null;
  const display = String(user.displayName || '').trim();
  const username = String(user.username || '').trim();
  return display || username || null;
};

const memberIds = (pod: Record<string, unknown>): Set<string> => new Set(
  ((pod.members as unknown[]) || []).map((member) => idString(
    (member as { _id?: unknown; userId?: unknown })?._id
      || (member as { userId?: unknown })?.userId
      || member,
  )),
);

const objectId = (value: string, field: string): mongoose.Types.ObjectId => {
  if (!mongoose.Types.ObjectId.isValid(value)) throw fail('INVALID_FOCUS', `${field} must be a valid user id`, 400, { [field]: 'must be a valid user id' });
  return new mongoose.Types.ObjectId(value);
};

const normalizeInput = (raw: unknown): PodFocusInput => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail('INVALID_FOCUS', 'focus must be an object', 400);
  const value = raw as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'goal,nextTaskIds,ownerUserId,scope') {
    throw fail('INVALID_FOCUS', 'focus contains unknown fields', 400);
  }
  if (typeof value.goal !== 'string' || typeof value.scope !== 'string' || typeof value.ownerUserId !== 'string' || !Array.isArray(value.nextTaskIds)) {
    throw fail('INVALID_FOCUS', 'focus fields have invalid types', 400);
  }
  const goal = value.goal.trim();
  const scope = value.scope.trim();
  const ownerUserId = value.ownerUserId.trim();
  const nextTaskIds = value.nextTaskIds.map((taskId) => (typeof taskId === 'string' ? taskId.trim() : taskId));
  const fields: Record<string, string> = {};
  if (!goal || codePointLength(goal) > MAX_GOAL) fields.goal = `must be 1-${MAX_GOAL} characters`;
  if (!scope || codePointLength(scope) > MAX_SCOPE) fields.scope = `must be 1-${MAX_SCOPE} characters`;
  if (!ownerUserId) fields.ownerUserId = 'is required';
  if (nextTaskIds.length > MAX_TASK_REFS) fields.nextTaskIds = `must contain at most ${MAX_TASK_REFS} tasks`;
  if (nextTaskIds.some((taskId) => typeof taskId !== 'string' || !taskId || codePointLength(taskId) > MAX_TASK_ID)) {
    fields.nextTaskIds = `each task id must be 1-${MAX_TASK_ID} characters`;
  }
  if (new Set(nextTaskIds.filter((taskId): taskId is string => typeof taskId === 'string')).size !== nextTaskIds.length) {
    fields.nextTaskIds = 'must contain unique task ids';
  }
  if (Object.keys(fields).length) throw fail('INVALID_FOCUS', 'focus failed validation', 400, fields);
  return { goal, scope, ownerUserId, nextTaskIds: nextTaskIds as string[] };
};

const revisionFromPod = (pod: Record<string, unknown>): number => {
  const value = Number(pod.focusRevision ?? (pod.focus as Record<string, unknown> | null)?.revision ?? 0);
  return Number.isInteger(value) && value >= 0 ? value : 0;
};

const queryByIds = async <T>(query: unknown): Promise<T[]> => {
  const result = await (Task.find(query) as { lean: () => Promise<T[]> }).lean();
  return Array.isArray(result) ? result : [];
};

class PodFocusService {
  static async permissions({ podId, userId }: { podId: string; userId: string }): Promise<{ canEdit: boolean }> {
    const [pod, actor] = await Promise.all([
      Pod.findById(podId).select('_id createdBy members').lean() as Promise<Record<string, unknown> | null>,
      User.findById(userId).select('_id isBot role').lean() as Promise<{ isBot?: boolean; role?: string } | null>,
    ]);
    if (!pod || !actor || actor.isBot !== false) return { canEdit: false };
    const callerId = idString(userId);
    return {
      canEdit: idString(pod.createdBy) === callerId || actor.role === 'admin',
    };
  }

  static async readForPod({ pod, podId }: { pod: Record<string, unknown>; podId?: string }): Promise<PodFocusRead> {
    const resolvedPodId = idString(podId || pod._id);
    const revision = revisionFromPod(pod);
    const stored = pod.focus as Record<string, unknown> | null | undefined;
    if (!stored || !stored.goal) return { podId: resolvedPodId, revision, focus: null };

    const ownerId = idString(stored.ownerUserId);
    const updaterId = idString(stored.updatedBy);
    const [users, tasks] = await Promise.all([
      User.find({ _id: { $in: [ownerId, updaterId].filter((id) => mongoose.Types.ObjectId.isValid(id)) } })
        .select('_id username displayName isBot')
        .lean(),
      queryByIds<Record<string, unknown>>({ podId: resolvedPodId, taskId: { $in: Array.isArray(stored.nextTaskIds) ? stored.nextTaskIds : [] } }),
    ]);
    const userRows = (users as Array<Record<string, unknown>>).reduce((map, user) => {
      map.set(idString(user._id), user);
      return map;
    }, new Map<string, Record<string, unknown>>());
    const taskRows = new Map(tasks.map((task) => [idString(task.taskId), task]));
    const ids = Array.isArray(stored.nextTaskIds) ? stored.nextTaskIds as string[] : [];
    const members = memberIds(pod);
    const owner = userRows.get(ownerId) || null;
    return {
      podId: resolvedPodId,
      revision,
      focus: {
        goal: String(stored.goal),
        scope: String(stored.scope || ''),
        owner: { userId: ownerId, label: labelFor(owner), available: members.has(ownerId) && Boolean(owner) },
        nextTasks: ids.map((taskId) => {
          const task = taskRows.get(taskId);
          return {
            taskId,
            available: Boolean(task),
            title: task ? String(task.title || '') : null,
            status: task ? String(task.status || '') : null,
            assignee: task?.assignee ? String(task.assignee) : null,
            updatedAt: task?.updatedAt ? dateString(task.updatedAt) : null,
          };
        }),
        updatedAt: dateString(stored.updatedAt),
        updatedBy: { userId: updaterId, label: labelFor(userRows.get(updaterId) || null) },
      },
    };
  }

  static async read({ podId, userId }: { podId: string; userId: string }): Promise<PodFocusRead> {
    if (!userId) throw fail('AUTH_REQUIRED', 'Authentication required', 401);
    const [pod, actor] = await Promise.all([
      Pod.findById(podId).select('_id members focus focusRevision').lean() as Promise<Record<string, unknown> | null>,
      User.findById(userId).select('_id isBot role').lean() as Promise<{ isBot?: boolean; role?: string } | null>,
    ]);
    if (!pod) throw fail('POD_NOT_FOUND', 'Pod not found', 404);
    const isHumanAdmin = actor?.isBot === false && actor.role === 'admin';
    if (!memberIds(pod).has(idString(userId)) && !isHumanAdmin) throw fail('NOT_A_MEMBER', 'Not authorized for this pod', 403);
    return PodFocusService.readForPod({ pod, podId });
  }

  static async update({ podId, userId, expectedRevision, focus }: { podId: string; userId: string; expectedRevision: number; focus: PodFocusInput | null }): Promise<PodFocusRead> {
    if (!userId) throw fail('AUTH_REQUIRED', 'Authentication required', 401);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw fail('INVALID_REVISION', 'expectedRevision must be a non-negative integer', 400);
    const actor = await User.findById(userId).select('_id isBot role').lean() as { _id?: unknown; isBot?: boolean; role?: string } | null;
    if (!actor || actor.isBot !== false) throw fail('FOCUS_HUMAN_REQUIRED', 'Only a human account may edit pod focus', 403);
    const pod = await Pod.findById(podId).select('_id createdBy members focus focusRevision').lean() as Record<string, unknown> | null;
    if (!pod) throw fail('POD_NOT_FOUND', 'Pod not found', 404);
    const callerId = idString(userId);
    const members = memberIds(pod);
    const isCreator = idString(pod.createdBy) === callerId;
    if (!isCreator && actor.role !== 'admin') throw fail('FOCUS_EDIT_FORBIDDEN', 'Only the pod creator or a global admin may edit pod focus', 403);

    let normalized: PodFocusInput | null = null;
    if (focus !== null) {
      normalized = normalizeInput(focus);
      if (!members.has(normalized.ownerUserId)) throw fail('INVALID_FOCUS', 'ownerUserId must be a current pod member', 400, { ownerUserId: 'must be a current pod member' });
      objectId(normalized.ownerUserId, 'ownerUserId');
      const owner = await User.findById(normalized.ownerUserId).select('_id').lean() as { _id?: unknown } | null;
      if (!owner) throw fail('INVALID_FOCUS', 'ownerUserId must identify an existing user', 400, { ownerUserId: 'must identify an existing user' });
      const taskRows = await queryByIds<Record<string, unknown>>({ podId, taskId: { $in: normalized.nextTaskIds } });
      if (taskRows.length !== normalized.nextTaskIds.length) throw fail('INVALID_FOCUS', 'Every next task must belong to this pod', 400, { nextTaskIds: 'contains an unavailable task' });
    }
    const currentRevision = revisionFromPod(pod);
    if (expectedRevision !== currentRevision) {
      const current = await Pod.findById(podId).select('_id members focus focusRevision').lean() as Record<string, unknown>;
      throw fail('FOCUS_CONFLICT', 'Focus changed while you were editing', 409, { expectedRevision: String(expectedRevision), currentRevision: String(revisionFromPod(current || {})) });
    }
    const nextRevision = currentRevision + 1;
    const focusDoc = normalized ? {
      goal: normalized.goal,
      scope: normalized.scope,
      ownerUserId: new mongoose.Types.ObjectId(normalized.ownerUserId),
      nextTaskIds: normalized.nextTaskIds,
      revision: nextRevision,
      updatedAt: new Date(),
      updatedBy: new mongoose.Types.ObjectId(callerId),
    } : null;
    const revisionPredicate = { $or: [{ focusRevision: currentRevision }, { focusRevision: { $exists: false } }, { focusRevision: null }] };
    const updated = await Pod.findOneAndUpdate(
      { _id: podId, ...revisionPredicate, ...(normalized ? { members: new mongoose.Types.ObjectId(normalized.ownerUserId) } : {}) },
      { $set: { focus: focusDoc, focusRevision: nextRevision } },
      { new: true },
    ).lean() as Record<string, unknown> | null;
    if (!updated) {
      const current = await Pod.findById(podId).select('_id members focus focusRevision').lean() as Record<string, unknown>;
      if (!current) throw fail('POD_NOT_FOUND', 'Pod not found', 404);
      if (normalized && !memberIds(current).has(normalized.ownerUserId)
        && revisionFromPod(current) === currentRevision) {
        throw fail('INVALID_FOCUS', 'ownerUserId must be a current pod member', 400, { ownerUserId: 'must be a current pod member' });
      }
      throw fail('FOCUS_CONFLICT', 'Focus changed while you were editing', 409, { expectedRevision: String(expectedRevision), currentRevision: String(revisionFromPod(current)) });
    }
    return PodFocusService.readForPod({ pod: updated, podId });
  }
}

export default PodFocusService;
// CJS compat: let require() return the default export directly.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
