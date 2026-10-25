import { Types } from 'mongoose';
import Task from '../../models/Task';
import User from '../../models/User';
import { PlaybookDefinition, PlaybookError } from './definition';
import { checkPlaybookDone, StepRecord } from './doneCheck';
import { loadPlaybookContext } from './context';
import { preflightPlaybook, PlaybookMember } from './preflight';
import { withPlaybookLock, playbookConfig, playbookDefinition, requirePlaybookHuman } from './store';

type BoundRun = { book: PlaybookDefinition; members: Map<string, PlaybookMember> };
const runIdentity = (ref: string | undefined) => /^playbook:([a-f0-9]{24}):(.+)$/.exec(ref || '');
const update = (text: string) => ({ text, author: 'playbook', createdAt: new Date() });

/** The unique source identity wins; an unrelated task-number collision is retried. */
const insertRow = async (fields: Record<string, unknown>) => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const existing = await Task.findOne({ podId: fields.podId, sourceRef: fields.sourceRef });
    if (existing) return { row: existing, created: false };
    const last = await Task.findOne({ podId: fields.podId }).sort({ taskNum: -1 }).select('taskNum').lean();
    const taskNum = (last?.taskNum || 0) + 1;
    try {
      const row = await Task.create({ ...fields, taskNum, taskId: `TASK-${String(taskNum).padStart(3, '0')}` });
      return { row, created: true };
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
  }
  throw new PlaybookError('task_number_busy', 'Board is busy; retry the playbook');
};

const bindCurrentRun = async (podId: string, installation: any, installable: any): Promise<BoundRun> => {
  const config = playbookConfig(installation);
  // The run owner must remain a human member, including scheduled starts.
  await requirePlaybookHuman(podId, String(config.onBy || ''));
  return preflightPlaybook(playbookDefinition(installable), config.bindings, await loadPlaybookContext(podId));
};

const advanceLocked = async (run: any, installation: any, installable: any) => {
  if (run.status === 'done') return null;
  const { book, members } = await bindCurrentRun(String(run.podId), installation, installable);
  const rows = await Task.find({ podId: run.podId, source: 'playbook', parentTask: run.taskId });
  const byRef = new Map(rows.map((row) => [row.sourceRef, row]));
  const facts = new Map<string, StepRecord>();
  for (let index = 0; index < book.steps.length; index += 1) {
    const step = book.steps[index];
    const sourceRef = `${run.sourceRef}:${index + 1}`;
    let existing = byRef.get(sourceRef);
    if (existing?.guard === 'kernel' && step.approval?.act === 'kernel'
      && existing.ruling?.state === 'approved' && existing.status !== 'done') {
      existing = await Task.findOneAndUpdate({ _id: existing._id, status: { $ne: 'done' },
        'ruling.state': 'approved', 'ruling.approvalId': existing.ruling.approvalId }, {
        $set: { status: 'done', completedAt: existing.ruling.decidedAt || new Date() },
        $push: { updates: update('Recovered approved kernel step') },
      }, { new: true }) || existing;
    }
    if (existing) {
      facts.set(step.key, existing);
      if (existing.status !== 'done') return existing;
      // A corrupt or legacy completion never advances past a missing ruling.
      if (step.approval && existing.ruling?.state !== 'approved') {
        await Task.updateOne({ _id: run._id, status: { $ne: 'blocked' } }, {
          $set: { status: 'blocked' }, $push: { updates: update(`${step.title}: approval required`) },
        });
        return existing;
      }
      continue;
    }
    const member = members.get(step.role)!;
    const kernel = step.approval?.act === 'kernel';
    const result = await insertRow({ podId: run.podId, source: 'playbook', sourceRef,
      parentTask: run.taskId, title: step.title, assignee: member.handle,
      ...(kernel ? { guard: 'kernel' } : member.kind === 'person' ? { guard: 'person' } : {}),
      ...(step.approval ? { ruling: { state: 'awaiting', approvalId: new Types.ObjectId() } } : {}),
      notes: `${run.notes || ''}\n\n${step.do}${step.writeGap ? `\n\nDrafted here; a person files it in ${step.writeGap} (writes not connected).` : ''}`,
      updates: [update(`Playbook ${run.taskId} · step ${index + 1} of ${book.steps.length}`)],
    });
    return result.row;
  }
  const humanIds = Array.from(members.values()).filter((member) => member.kind === 'person').map((member) => member.userId);
  const humans = await User.find({ _id: { $in: humanIds }, isBot: { $ne: true }, botType: { $in: [null, ''] } })
    .select('_id').lean();
  const checked = checkPlaybookDone(book, facts, new Set(humans.map((person) => String(person._id))));
  await Task.updateOne({ _id: run._id, source: 'playbook', guard: 'kernel', status: { $ne: 'done' } }, {
    $set: { status: checked.done ? 'done' : 'blocked', ...(checked.done ? { completedAt: new Date() } : {}) },
    $push: { updates: update(checked.done ? 'Done check passed' : `Done check failed: ${checked.failed.join('; ')}`) },
  });
  return null;
};

export const startPlaybookRun = async (options: {
  podId: string; installationId: string; userId: string; triggerKey: string; input: string; label: string;
}) => {
  const { podId, installationId, userId, triggerKey, input, label } = options;
  if (process.env.PLAYBOOKS_ENABLED !== 'true') throw new PlaybookError('playbooks_disabled', 'Playbooks are not enabled');
  await requirePlaybookHuman(podId, userId);
  if (!/^(?:manual:[a-f0-9-]{36}|schedule:\d{4}-\d\d-\d\dT\d\d:\d\d)$/.test(triggerKey)
    || typeof input !== 'string' || input.length > 8000 || typeof label !== 'string' || label.length > 240) {
    throw new PlaybookError('invalid_trigger', 'Invalid Run or schedule trigger', 400);
  }
  return withPlaybookLock(podId, installationId, async (installation, installable) => {
    if (installation.status !== 'active') throw new PlaybookError('playbook_off', 'Turn this playbook On first');
    const bound = await bindCurrentRun(podId, installation, installable);
    const config = playbookConfig(installation);
    const result = await insertRow({ podId, source: 'playbook', sourceRef: `playbook:${installation._id}:${triggerKey}`,
      title: 'Playbook run', guard: 'kernel', status: 'claimed', claimedBy: String(config.onBy),
      assignee: bound.members.size ? (await User.findById(config.onBy).select('username').lean())?.username : null,
      notes: `${installable.name}\n${label}\n\nInput:\n${input}`, updates: [update(label)],
    });
    // Recover a crash after the root insert, and never reopen an old run.
    const step = await advanceLocked(result.row, installation, installable);
    return { run: result.row, step, created: result.created };
  });
};

/** Shared completion, card settlement and the reconciler all converge here. */
export const advancePlaybookRun = async (podId: string, taskId: string) => {
  const task = await Task.findOne({ podId, taskId, source: 'playbook' });
  if (!task) return null;
  const run = task.parentTask ? await Task.findOne({ podId, taskId: task.parentTask, source: 'playbook' }) : task;
  const identity = runIdentity(run?.sourceRef);
  if (!run || !identity || run.status === 'done') return null;
  try {
    return await withPlaybookLock(podId, identity[1],
      (installation, installable) => advanceLocked(run, installation, installable));
  } catch (error) {
    if (!(error instanceof PlaybookError)) throw error;
    // A concurrent winner or the sweep will deliver the next step. Other
    // capability/membership refusals stop the run with a visible reason.
    if (error.code !== 'playbook_busy') await Task.updateOne({ _id: run._id, status: { $ne: 'done' } }, {
      $set: { status: 'blocked' }, $push: { updates: update(error.message) },
    });
    return null;
  }
};
