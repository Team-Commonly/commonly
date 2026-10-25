import AgentTaskWakeState from '../models/AgentTaskWakeState';
import AgentEvent from '../models/AgentEvent';
import AgentRun from '../models/AgentRun';
import Task from '../models/Task';
import User from '../models/User';
import { AgentInstallation } from '../models/AgentRegistry';

const DELAY_MS = 5 * 60 * 1000;
const INTERVAL_MS = 30 * 60 * 1000;
const seatKey = (name: unknown, instance: unknown): string => JSON.stringify([
  String(name || '').toLowerCase(), String(instance || 'default').toLowerCase(),
]);
const normalized = (value: unknown): string => String(value || '').toLowerCase();
const exactIgnoringCase = (value: string): RegExp => (
  new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
);

type Installation = { agentName: string; instanceId: string; podId: unknown };
type Row = {
  _id: unknown; podId: unknown; taskId: string; title: string; status: string;
  assignee?: string | null; claimedBy?: string | null; dep?: string | null; depMockOk?: boolean;
};

function owns(row: Row, install: Installation, principalId: string): boolean {
  const name = normalized(install.agentName);
  const instance = normalized(install.instanceId || 'default');
  const alias = instance === 'default' ? name : instance;
  const holder = normalized(row.claimedBy);
  if (row.status === 'claimed') {
    // A stale assignment never wakes a different seat from the live claimant.
    return holder === principalId || holder === alias;
  }
  return normalized(row.assignee) === alias;
}

async function hasOtherWork(agentName: string, instanceId: string): Promise<boolean> {
  const [queued, running] = await Promise.all([
    AgentEvent.exists({
      agentName, instanceId, status: { $in: ['pending', 'folding', 'delivered'] },
      deliveryMode: { $ne: 'digest' },
    }),
    AgentRun.exists({ agentName, instanceId, status: { $in: ['queued', 'running'] } }),
  ]);
  return Boolean(queued || running);
}

async function actionableRows(rows: Row[]): Promise<Row[]> {
  const dependencies = await Task.find({
    podId: { $in: rows.map((row) => row.podId) },
    taskId: { $in: rows.map((row) => row.dep).filter(Boolean) },
  }).select('podId taskId status').lean();
  const done = new Set(dependencies.filter((row) => row.status === 'done')
    .map((row) => `${row.podId}:${row.taskId}`));
  return rows.filter((row) => !row.dep || row.depMockOk || done.has(`${row.podId}:${row.dep}`));
}

export async function dispatchAssignedTaskWakes(now = new Date()): Promise<{ eligible: number; woken: number }> {
  const open = await Task.find({
    source: { $ne: 'playbook' },
    status: { $in: ['pending', 'claimed'] },
    $or: [
      { assignee: { $type: 'string', $ne: '' } },
      { status: 'claimed', claimedBy: { $type: 'string', $ne: '' } },
    ],
  })
    .select('_id podId taskId title status assignee claimedBy dep depMockOk').lean() as Row[];
  const rows = await actionableRows(open);
  if (!rows.length) return { eligible: 0, woken: 0 };
  const installs = await AgentInstallation.find({
    podId: { $in: rows.map((row) => row.podId) }, status: 'active',
  }).select('agentName instanceId podId').lean() as Installation[];
  const principals = await User.find({
    isBot: true,
    'botMetadata.agentName': { $in: [...new Set(installs.map((install) => install.agentName))].map(exactIgnoringCase) },
  }).select('_id botMetadata').lean();
  const principalIds = new Map(principals.map((user) => [
    seatKey(user.botMetadata?.agentName, user.botMetadata?.instanceId), String(user._id),
  ]));
  const visited = new Set<string>();
  let eligible = 0;
  let woken = 0;
  for (const install of installs) {
    const key = seatKey(install.agentName, install.instanceId);
    if (visited.has(key)) continue;
    const principalId = principalIds.get(key);
    if (!principalId) continue;
    const owned = rows.filter((row) => String(row.podId) === String(install.podId)
      && owns(row, install, principalId));
    if (!owned.length) continue;
    visited.add(key);
    // Historical webhook rows lost their reasons. Silent completions require
    // durable writer provenance, independent of mutable runtime configuration.
    // Skips are not turns and must not hide an earlier completed turn. Use
    // exactly this predicate again after reserving the wake slot.
    const completionFilter = {
      agentName: install.agentName, instanceId: install.instanceId,
      deliveryMode: { $ne: 'digest' }, status: 'acked',
      'delivery.updatedAt': { $type: 'date' },
      $or: [
        { 'delivery.outcome': { $in: ['posted', 'acknowledged'] } },
        {
          'delivery.outcome': 'no_action',
          'delivery.reason': { $in: [null, ''] },
          'delivery.reasonRecorded': true,
        },
      ],
    };
    // eslint-disable-next-line no-await-in-loop
    const last = await AgentEvent.findOne(completionFilter).sort({ 'delivery.updatedAt': -1 }).lean();
    if (!last?.delivery?.updatedAt) continue;
    const dueAt = new Date(new Date(last.delivery.updatedAt).getTime() + DELAY_MS);
    if (dueAt > now) continue;
    // eslint-disable-next-line no-await-in-loop
    if (await hasOtherWork(install.agentName, install.instanceId)) continue;
    eligible += 1;
    let reserved = false;
    let enqueueStarted = false;
    try {
      // Upsert's duplicate _id loser is the capped/racing worker. The cap is
      // per seat, not per pod, and survives process restarts and event GC.
      // eslint-disable-next-line no-await-in-loop
      const state = await AgentTaskWakeState.findOneAndUpdate({
        _id: key,
        $or: [{ lastWakeAt: { $lte: new Date(now.getTime() - INTERVAL_MS) } }, { lastWakeAt: null }],
      }, { $set: { lastWakeAt: now } }, { upsert: true, new: true });
      reserved = Boolean(state);
      // An assignment, pause or queued wake can change during reservation.
      // Recheck the actual rows and installation before crossing enqueue.
      // eslint-disable-next-line no-await-in-loop
      const [currentRows, active, busy, newest] = await Promise.all([
        Task.find({ _id: { $in: owned.map((row) => row._id) }, status: { $in: ['pending', 'claimed'] } }).lean(),
        AgentInstallation.exists({ ...install, status: 'active' }),
        hasOtherWork(install.agentName, install.instanceId),
        AgentEvent.findOne(completionFilter).sort({ 'delivery.updatedAt': -1 }).select('_id').lean(),
      ]);
      // eslint-disable-next-line no-await-in-loop
      const current = await actionableRows((currentRows as Row[]).filter((row) => owns(row, install, principalId)));
      if (!active || busy || !current.length || String(newest?._id) !== String(last._id)) {
        // eslint-disable-next-line no-await-in-loop
        await AgentTaskWakeState.updateOne({ _id: key, lastWakeAt: now }, { $unset: { lastWakeAt: 1 } });
        continue;
      }
      // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
      const AgentEventService = require('./agentEventService');
      enqueueStarted = true;
      // eslint-disable-next-line no-await-in-loop
      await AgentEventService.enqueue({
        agentName: install.agentName, instanceId: install.instanceId, podId: String(install.podId),
        type: 'chat.mention',
        payload: {
          triggerAuthor: 'kernel', assignedTaskWake: true,
          content: '[Your assigned work is still open]\n\n'
            + current.slice(0, 5).map((row) => `- ${row.taskId}: ${row.title.slice(0, 220)}`).join('\n')
            + '\n\nContinue the next actionable row. Recheck its current state and claim it before starting. '
            + 'If you are waiting on a dependency or operator gate, mark the row blocked with the reason. '
            + 'Post only an action or a materially useful result.',
        },
      });
      woken += 1;
    } catch (error) {
      if ((error as { code?: number }).code === 11000 && !reserved) continue;
      if (reserved && !enqueueStarted) {
        // No queue write was attempted, so returning this slot is safe.
        // eslint-disable-next-line no-await-in-loop
        await AgentTaskWakeState.updateOne({ _id: key, lastWakeAt: now }, { $unset: { lastWakeAt: 1 } });
        console.error('[assigned-task-wake] preflight failed:', key, (error as Error).message);
        continue;
      }
      // An enqueue can persist before reporting failure. Keep its reservation
      // on an ambiguous error so a retry cannot bypass the thirty-minute cap.
      throw error;
    }
  }
  return { eligible, woken };
}
