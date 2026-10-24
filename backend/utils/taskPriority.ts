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
