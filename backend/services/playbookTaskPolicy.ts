/** Shared write predicates: API reads explain refusals; the CAS enforces them. */
export interface TaskActor {
  userId: string;
  isBot: boolean;
  assignee: string;
}

interface GuardedTask {
  source?: string;
  guard?: string;
  assignee?: string | null;
  ruling?: { state?: string; approvalId?: unknown };
}

const assignedTo = (actor: TaskActor) => [actor.userId, actor.assignee].filter(Boolean);

export const taskActionConditions = (actor: TaskActor): Record<string, unknown> => ({
  $and: [
    { $or: [{ ruling: { $exists: false } }, { 'ruling.state': 'approved' }] },
    { guard: { $nin: actor.isBot ? ['kernel', 'person'] : ['kernel'] } },
    { $or: [{ source: { $ne: 'playbook' } }, { assignee: { $in: assignedTo(actor) } }] },
  ],
});

export const taskActionRefusal = (task: GuardedTask, actor: TaskActor) => {
  if (task.ruling && task.ruling.state !== 'approved') {
    return { error: 'Approve the step before claiming or completing it', code: 'awaiting_ruling', approvalId: task.ruling.approvalId, ruling: task.ruling.state };
  }
  if (task.guard === 'kernel' || (task.guard === 'person' && actor.isBot)) {
    return { error: task.guard === 'kernel' ? 'Only the playbook runner can move this row' : 'This step requires a person', code: 'task_guard', guard: task.guard };
  }
  if (task.source === 'playbook' && !assignedTo(actor).includes(task.assignee || '')) {
    return { error: 'Only the bound role member can move this step', code: 'playbook_assignee' };
  }
  return null;
};

export const taskPatchRefusal = (task: GuardedTask, actor: TaskActor, fields: Record<string, unknown>) => {
  if (task.source !== 'playbook') return null;
  if (task.guard === 'kernel' && fields.status !== undefined) {
    return { error: 'Only the runner can move a kernel row', code: 'task_guard' };
  }
  const invalid = Object.keys(fields).find((key) => key !== 'notes'
    && !(key === 'status' && fields.status === 'blocked')
    && !(key === 'prUrl' && assignedTo(actor).includes(task.assignee || '')));
  return invalid ? { error: `Playbook rows cannot change ${invalid} through PATCH`, code: 'playbook_patch' } : null;
};
