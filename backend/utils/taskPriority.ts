export const TASK_PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;
export type TaskPriority = typeof TASK_PRIORITIES[number];

export function isTaskPriority(value: unknown): value is TaskPriority {
  return typeof value === 'string' && TASK_PRIORITIES.some((priority) => priority === value);
}

// Legacy rows read as P2 until the silent migration fills the stored field.
export function compareTaskPriority(
  left: { priority?: unknown; taskNum?: unknown; taskId?: unknown },
  right: { priority?: unknown; taskNum?: unknown; taskId?: unknown },
): number {
  const priority = (isTaskPriority(left.priority) ? left.priority : 'P2')
    .localeCompare(isTaskPriority(right.priority) ? right.priority : 'P2');
  return priority || Number(left.taskNum || 0) - Number(right.taskNum || 0)
    || String(left.taskId || '').localeCompare(String(right.taskId || ''));
}

// Normalize missing legacy fields before Mongo sorts or limits the result.
export const TASK_PRIORITY_ORDER = [
  { $set: { priority: { $ifNull: ['$priority', 'P2'] } } },
  { $sort: { priority: 1, taskNum: 1, _id: 1 } },
] as const;
