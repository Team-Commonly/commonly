import { randomUUID } from 'crypto';
import Installable from '../../models/Installable';
import Installation from '../../models/InstallableInstallation';
import Task from '../../models/Task';
import User from '../../models/User';
import Pod from '../../models/Pod';
import PodAssetService from '../podAssetService';
import { PLAYBOOK_HANDLER, isPlaybook } from './identity';
import { PlaybookError, validatePlaybook } from './definition';
import { loadPlaybookContext } from './context';
import { preflightPlaybook } from './preflight';
import { validateSchedule, PlaybookSchedule } from './schedule';

const COMPONENT = 'playbook';
const LOCK_MS = 60_000;

export const requirePlaybookHuman = async (podId: string, userId: string): Promise<void> => {
  const [pod, user] = await Promise.all([
    Pod.findById(podId).select('members').lean(),
    User.findById(userId).select('isBot botType').lean(),
  ]);
  if (!pod || !(pod.members || []).some((id) => String(id) === userId)) {
    throw new PlaybookError('pod_membership_required', 'Join this pod before changing its playbooks', 403);
  }
  if (!user || user.isBot || user.botType) {
    throw new PlaybookError('human_required', 'A human pod member must change playbooks', 403);
  }
};

export interface DraftInput {
  title: string;
  definition: unknown;
  sourceText?: string;
  bindings?: Record<string, string>;
  schedule?: PlaybookSchedule;
}
const checkedDraft = (draft: DraftInput) => {
  if (typeof draft.title !== 'string' || !draft.title.trim() || draft.title.length > 160) {
    throw new PlaybookError('invalid_title', 'Give the playbook a title of at most 160 characters', 400);
  }
  if (draft.sourceText !== undefined && typeof draft.sourceText !== 'string') {
    throw new PlaybookError('invalid_source', 'Source must be text', 400);
  }
  return { book: validatePlaybook(draft.definition), schedule: draft.schedule && validateSchedule(draft.schedule) };
};

/** The same per-installation lease serializes edits, On/Off and run creation. */
export const withPlaybookLock = async <T>(
  podId: string, installationId: string,
  action: (installation: any, installable: any, claimId: string) => Promise<T>,
): Promise<T> => {
  const claimId = randomUUID();
  const row = await Installation.findOneAndUpdate({ _id: installationId, targetType: 'pod', targetId: podId,
    status: { $in: ['active', 'paused'] },
    $or: [{ claimId: { $exists: false } }, { claimId: null }, { claimedAt: { $lt: new Date(Date.now() - LOCK_MS) } }],
  }, { $set: { claimId, claimedAt: new Date() } }, { new: true }).lean();
  if (!row) throw new PlaybookError('playbook_busy', 'Playbook unavailable or being changed; retry');
  try {
    const installable = await Installable.findOne({ installableId: row.installableId }).lean();
    if (!installable || !isPlaybook(installable)) {
      throw new PlaybookError('playbook_not_found', 'Playbook not found', 404);
    }
    return await action(row, installable, claimId);
  } finally {
    await Installation.updateOne({ _id: row._id, claimId }, { $unset: { claimId: '', claimedAt: '' } });
  }
};

export const playbookConfig = (installation: any): Record<string, any> => {
  const config = installation.components.find((entry: any) => entry.componentName === COMPONENT)?.config;
  return config instanceof Map ? Object.fromEntries(config) : (config || {});
};
export const playbookDefinition = (installable: any): unknown => installable.components
  .find((entry: any) => entry.eventHandler === PLAYBOOK_HANDLER)?.metadata?.playbook;

export const assertNoOpenRun = async (podId: string, installationId: string): Promise<void> => {
  const open = await Task.exists({ podId, source: 'playbook', guard: 'kernel', parentTask: null,
    sourceRef: { $regex: `^playbook:${installationId}:` }, status: { $ne: 'done' } });
  if (open) throw new PlaybookError('run_open', 'Finish the open run before editing the playbook');
};

/** Draft creation always stays Off, including a Scout proposal approved by a person. */
export const createOffPlaybook = async (podId: string, userId: string, draft: DraftInput) => {
  await requirePlaybookHuman(podId, userId);
  const { book, schedule } = checkedDraft(draft);
  const installableId = `playbook-${randomUUID()}`;
  const components: any[] = [{ name: COMPONENT, type: 'event-handler', eventHandler: PLAYBOOK_HANDLER,
    metadata: { playbook: book, sourceSkill: installableId } }];
  if (schedule) components.push({ name: 'schedule', type: 'scheduled-job',
    cron: schedule.cron, jobHandler: 'internal:playbook.schedule' });
  const installable = await Installable.create({ installableId, name: draft.title.trim(), description: 'Pod playbook',
    version: '1.0.0', kind: 'app', scope: 'pod', source: 'user', owner: userId, components });
  try {
    if (draft.sourceText) await PodAssetService.upsertSkillAsset({ podId, name: installableId,
      markdown: draft.sourceText, metadata: { playbook: installableId } });
    return await Installation.create({ installableId, installableVersion: '1.0.0', targetType: 'pod', targetId: podId,
      scope: 'pod', installedBy: userId, installSource: 'ui', status: 'paused',
      components: [{ componentName: COMPONENT, componentType: 'event-handler', status: 'paused',
        config: { bindings: draft.bindings || {}, ...(schedule ? { schedule } : {}) } }] });
  } catch (error) {
    await Installable.deleteOne({ _id: installable._id });
    throw error;
  }
};

export const setPlaybookOn = async (podId: string, userId: string, installationId: string,
  bindings: Record<string, string>, on: boolean) => {
  await requirePlaybookHuman(podId, userId);
  if (on && process.env.PLAYBOOKS_ENABLED !== 'true') {
    throw new PlaybookError('playbooks_disabled', 'Playbooks are not enabled on this instance');
  }
  return withPlaybookLock(podId, installationId, async (installation, installable, claimId) => {
    const config = playbookConfig(installation);
    if (on) {
      await assertNoOpenRun(podId, installationId);
      preflightPlaybook(playbookDefinition(installable), bindings, await loadPlaybookContext(podId));
      if (config.schedule) validateSchedule(config.schedule);
    }
    const updated = await Installation.findOneAndUpdate({ _id: installation._id, claimId,
      claimedAt: { $gt: new Date(Date.now() - LOCK_MS) } }, {
      $set: { status: on ? 'active' : 'paused', 'components.0.status': on ? 'active' : 'paused',
        'components.0.config': { ...config, ...(on ? { bindings, onBy: userId, onAt: new Date() } : {}) } },
    }, { new: true });
    if (!updated) throw new PlaybookError('playbook_busy', 'Playbook changed; retry');
    return updated;
  });
};
