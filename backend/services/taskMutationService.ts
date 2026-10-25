import { TaskActor } from './playbookTaskPolicy';
import { completeTaskWithRevision as completeCore } from './taskMutationCore';
import { advancePlaybookRun } from './playbooks/runState';
import { deliverPlaybookStep } from './playbooks/delivery';
import { proposeAction } from './approvalActionService';
import AgentEventService from './agentEventService';

export { updateTaskWithRevisionSnapshot, updateTaskWithRevision, claimTaskWithRevision } from './taskMutationCore';

export const completeTaskWithRevision = async (
  filter: Record<string, unknown>, update: Record<string, unknown>, actor: TaskActor,
) => {
  const task = await completeCore(filter, update, actor);
  if (task?.source === 'playbook') {
    const next = await advancePlaybookRun(String(task.podId), task.taskId);
    if (next) await deliverPlaybookStep(String(task.podId), next.taskId,
      (event) => AgentEventService.enqueue(event), proposeAction);
  }
  return task;
};
