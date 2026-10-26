import { escapeRegExp } from '../utils/escapeRegExp';
import { Types } from 'mongoose';
import AgentTaskWakeState from '../models/AgentTaskWakeState';
import AgentTaskRowWakeState from '../models/AgentTaskRowWakeState';
import AgentEvent from '../models/AgentEvent';
import AgentRun from '../models/AgentRun';
import Task from '../models/Task';
import User from '../models/User';
import Pod from '../models/Pod';
import { AgentInstallation } from '../models/AgentRegistry';
import { carriesAgentMarkers, isReservedAgentEmail } from './agentIdentityService';

const DELAY_MS = 5 * 60 * 1000;
const INTERVAL_MS = 30 * 60 * 1000;
// Consecutive failed wake runs on one row before the wake gives up on it.
const STOP_AFTER_FAILURES = 3;
const STOPPED_NOTE = 'I stopped retrying this after repeated errors. Reassign it or update it to try again.';
const seatKey = (name: unknown, instance: unknown): string => JSON.stringify([
  String(name || '').toLowerCase(), String(instance || 'default').toLowerCase(),
]);
const normalized = (value: unknown): string => String(value || '').toLowerCase();
const exactIgnoringCase = (value: string): RegExp => (
  new RegExp(`^${escapeRegExp(value)}$`, 'i')
);

type Installation = { agentName: string; instanceId: string; podId: unknown };
type Row = {
  _id: unknown; podId: unknown; taskId: string; title: string; status: string;
  assignee?: string | null; claimedBy?: string | null; dep?: string | null; depMockOk?: boolean;
  source?: string; updates?: Array<{ authorId?: string | null; createdAt?: Date }>;
};
type RowState = {
  _id: string; lastWakeAt?: Date | null; lastWakeEventId?: unknown; countedEventId?: unknown;
  failures?: number; stoppedAt?: Date | null;
};
type WakeEvent = { _id: unknown; status?: string; delivery?: { outcome?: string; reason?: string | null } };

const rowKey = (seat: string, row: Row): string => `${seat}|${String(row._id)}`;

// The dispatcher runs every minute, so a gate that keeps holding a seat would
// repeat its line each run. Each (seat, rows, gate) logs once per interval.
const skipLoggedAt = new Map<string, number>();
function logSkip(install: Installation, rows: Row[], gate: string, now: Date): void {
  const seat = `${install.agentName}/${install.instanceId || 'default'}`;
  const taskIds = rows.map((row) => row.taskId).join(',') || '-';
  const key = `${seat}|${taskIds}|${gate}`;
  const last = skipLoggedAt.get(key);
  if (last !== undefined && now.getTime() - last < INTERVAL_MS) return;
  if (skipLoggedAt.size > 5000) {
    skipLoggedAt.forEach((at, logged) => {
      if (now.getTime() - at >= INTERVAL_MS) skipLoggedAt.delete(logged);
    });
  }
  skipLoggedAt.set(key, now.getTime());
  console.debug(`[assigned-task-wake] skip seat=${seat} rows=${taskIds} gate=${gate}`);
}

// Native rows record no author: their id is minted `N-<num>-<agentName>-<base36>`.
// Rows created through the API open with a "Created by" update carrying the author's id.
const NATIVE_TASK_ID = /^N-\d+-(.+)-[0-9a-z]+$/;

function selfCreated(row: Row, install: Installation, principalId: string): boolean {
  if (row.source !== 'agent') return false;
  const authorId = row.updates?.[0]?.authorId;
  if (authorId) return String(authorId) === principalId;
  const minted = NATIVE_TASK_ID.exec(row.taskId);
  return Boolean(minted) && normalized(minted?.[1]) === normalized(install.agentName);
}

// Agent rows written before `isBot` existed carry only the install markers
// (the derived address, botType, agentName), so a person is a row with neither
// the flag nor any of those markers. The address is checked as a domain here,
// not through isAgentOwnedRow: that guards adoption, where only this seat's own
// address counts. Erring toward "agent" only keeps a self-set row quiet.
async function anyHuman(ids: unknown[]): Promise<boolean> {
  const unique = [...new Set(ids.map((id) => String(id || '')))].filter((id) => Types.ObjectId.isValid(id));
  if (!unique.length) return false;
  const users = await User.find({ _id: { $in: unique }, isBot: { $ne: true } })
    .select('email botType botMetadata.agentName').lean() as Array<{
      email?: string | null; botType?: string | null; botMetadata?: { agentName?: string | null } | null;
    }>;
  return users.some((user) => !isReservedAgentEmail(user.email) && !carriesAgentMarkers(user));
}

const updatedSince = (row: Row, since: Date): unknown[] => (row.updates || [])
  .filter((update) => update.createdAt && new Date(update.createdAt) > since)
  .map((update) => update.authorId);

// A person posted in the pod, or created or updated any row in it, after `since`.
async function humanActedInPodSince(podId: unknown, since: Date): Promise<boolean> {
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const AgentMessageService = require('./agentMessageService');
  const rows = await Task.find({ podId, 'updates.createdAt': { $gt: since } })
    .select('updates.authorId updates.createdAt').lean() as Row[];
  if (await anyHuman(rows.flatMap((row) => updatedSince(row, since)))) return true;
  try {
    return await anyHuman(await AgentMessageService.authorIdsSince(podId, since));
  } catch (error) {
    // Fails closed: re-arming on an unreadable pod would bring back the
    // thirty-minute loop for as long as the read keeps failing. A missed re-arm
    // costs one delayed wake; the next update to a row re-arms it.
    console.warn('[assigned-task-wake] pod activity unreadable:', String(podId), (error as Error).message);
    return false;
  }
}

// 'open' until the wake's run settles; a run that did nothing for its own
// reason is neither a success nor a failure.
function verdictOf(event: WakeEvent | undefined): 'open' | 'failed' | 'succeeded' | 'neutral' {
  if (!event) return 'neutral';
  if (event.status === 'failed' || event.delivery?.outcome === 'error') return 'failed';
  if (event.status !== 'acked') return ['pending', 'folding', 'delivered'].includes(String(event.status)) ? 'open' : 'neutral';
  const outcome = event.delivery?.outcome;
  if (outcome === 'posted' || outcome === 'acknowledged') return 'succeeded';
  return outcome === 'no_action' && !event.delivery?.reason ? 'succeeded' : 'neutral';
}

async function countOutcomes(states: RowState[]): Promise<void> {
  const unsettled = states.filter((state) => state.lastWakeEventId
    && String(state.lastWakeEventId) !== String(state.countedEventId));
  if (!unsettled.length) return;
  const events = await AgentEvent.find({ _id: { $in: unsettled.map((state) => state.lastWakeEventId) } })
    .select('status delivery.outcome delivery.reason').lean() as WakeEvent[];
  const byId = new Map(events.map((event) => [String(event._id), event]));
  for (const state of unsettled) {
    const verdict = verdictOf(byId.get(String(state.lastWakeEventId)));
    if (verdict === 'open') continue;
    const failures = verdict === 'failed' ? (state.failures || 0) + 1 : verdict === 'succeeded' ? 0 : (state.failures || 0);
    // The prior countedEventId guards against two schedulers counting one run twice.
    // eslint-disable-next-line no-await-in-loop
    const counted = await AgentTaskRowWakeState.updateOne(
      { _id: state._id, countedEventId: state.countedEventId ?? null },
      { $set: { countedEventId: state.lastWakeEventId, failures } },
    );
    if (counted.modifiedCount) {
      state.countedEventId = state.lastWakeEventId;
      state.failures = failures;
    }
  }
}

// Says so once on the row, in the agent's name, without touching updatedAt:
// the note must not read as a fresh revision that offers the row again.
async function stopRow(row: Row, state: RowState, install: Installation, principalId: string, now: Date): Promise<void> {
  const stopped = await AgentTaskRowWakeState.updateOne(
    { _id: state._id, stoppedAt: null },
    { $set: { stoppedAt: now } },
  );
  if (!stopped.modifiedCount) return;
  const writeNote = () => Task.updateOne(
    { _id: row._id },
    { $push: { updates: { text: STOPPED_NOTE, author: install.agentName, authorId: principalId, createdAt: now } } },
    { timestamps: false },
  );
  try {
    await writeNote().catch(writeNote);
  } catch (error) {
    // Un-stop so the next dispatch says so again, rather than a silent stop.
    await AgentTaskRowWakeState.updateOne({ _id: state._id, stoppedAt: now }, { $set: { stoppedAt: null } });
    console.error('[assigned-task-wake] stop note not written:', state._id, (error as Error).message);
    return;
  }
  state.stoppedAt = now;
}

// The rows that may wake this seat now. A row the agent created for itself
// wakes it once, then again only after a person acts in the pod. Any other
// row wakes it until STOP_AFTER_FAILURES consecutive runs fail; a person
// updating the row, or a run that succeeds, starts the count again.
async function wakeableRows(
  owned: Row[], install: Installation, principalId: string, seat: string, now: Date,
): Promise<Row[]> {
  const states = await AgentTaskRowWakeState.find({ _id: { $in: owned.map((row) => rowKey(seat, row)) } })
    .lean() as RowState[];
  await countOutcomes(states);
  const byRow = new Map(states.map((state) => [state._id, state]));
  // Every row here is in the install's pod; read its activity once per cutoff.
  const actedSince = new Map<number, Promise<boolean>>();
  const humanActedSince = (since: Date): Promise<boolean> => {
    if (!actedSince.has(since.getTime())) actedSince.set(since.getTime(), humanActedInPodSince(install.podId, since));
    return actedSince.get(since.getTime()) as Promise<boolean>;
  };
  const wakeable: Row[] = [];
  for (const row of owned) {
    const state = byRow.get(rowKey(seat, row));
    if (selfCreated(row, install, principalId)) {
      // eslint-disable-next-line no-await-in-loop
      if (!state?.lastWakeAt || await humanActedSince(new Date(state.lastWakeAt))) wakeable.push(row);
      else logSkip(install, [row], 'awaiting-human', now);
      continue;
    }
    if (!state) {
      wakeable.push(row);
      continue;
    }
    const failing = Boolean(state.stoppedAt) || (state.failures || 0) > 0;
    // eslint-disable-next-line no-await-in-loop
    if (failing && state.lastWakeAt && await anyHuman(updatedSince(row, new Date(state.lastWakeAt)))) {
      // eslint-disable-next-line no-await-in-loop
      await AgentTaskRowWakeState.updateOne({ _id: state._id }, { $set: { failures: 0, stoppedAt: null } });
      wakeable.push(row);
      continue;
    }
    if (state.stoppedAt) {
      logSkip(install, [row], 'stopped', now);
      continue;
    }
    if ((state.failures || 0) >= STOP_AFTER_FAILURES) {
      // eslint-disable-next-line no-await-in-loop
      await stopRow(row, state, install, principalId, now);
      logSkip(install, [row], 'stopped', now);
      continue;
    }
    wakeable.push(row);
  }
  return wakeable;
}

// A post here would be refused until someone else speaks, so a wake could only spend tokens.
async function holdsFloor(install: Installation, principalId: string): Promise<boolean> {
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const AgentMessageService = require('./agentMessageService');
  const pod = await Pod.findById(install.podId).select('type').lean() as { type?: string } | null;
  return AgentMessageService.holdsFloor(install.podId, principalId, pod?.type);
}

function owns(row: Row, install: Installation, principalId: string | null): boolean {
  const name = normalized(install.agentName);
  const instance = normalized(install.instanceId || 'default');
  const alias = instance === 'default' ? name : instance;
  const holder = normalized(row.claimedBy);
  if (row.status === 'claimed') {
    // A stale assignment never wakes a different seat from the live claimant.
    return (principalId !== null && holder === principalId) || holder === alias;
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
    status: { $in: ['pending', 'claimed'] },
    $or: [
      { assignee: { $type: 'string', $ne: '' } },
      { status: 'claimed', claimedBy: { $type: 'string', $ne: '' } },
    ],
  })
    .select('_id podId taskId title status assignee claimedBy dep depMockOk source updates.authorId updates.createdAt')
    .lean() as Row[];
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
    if (!principalId) {
      const named = rows.filter((row) => String(row.podId) === String(install.podId) && owns(row, install, null));
      if (named.length) logSkip(install, named, 'no-principal', now);
      continue;
    }
    const assigned = rows.filter((row) => String(row.podId) === String(install.podId)
      && owns(row, install, principalId));
    if (!assigned.length) continue;
    visited.add(key);
    // eslint-disable-next-line no-await-in-loop
    const owned = await wakeableRows(assigned, install, principalId, key, now);
    if (!owned.length) continue;
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
    if (!last?.delivery?.updatedAt) {
      logSkip(install, owned, 'no-completed-turn', now);
      continue;
    }
    const dueAt = new Date(new Date(last.delivery.updatedAt).getTime() + DELAY_MS);
    if (dueAt > now) {
      logSkip(install, owned, 'delay', now);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    if (await hasOtherWork(install.agentName, install.instanceId)) {
      logSkip(install, owned, 'other-work', now);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    if (await holdsFloor(install, principalId)) {
      logSkip(install, owned, 'floor', now);
      continue;
    }
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
        logSkip(install, owned, 'recheck', now);
        continue;
      }
      const shown = current.slice(0, 5);
      const recordRows = (update: Record<string, unknown>) => AgentTaskRowWakeState.bulkWrite(shown.map((row) => ({
        updateOne: { filter: { _id: rowKey(key, row) }, update: { $set: update }, upsert: true },
      })));
      // Recorded before the wake is queued: a wake the stop rule cannot see
      // must not happen. On failure the slot is returned below and nothing queues.
      try {
        // eslint-disable-next-line no-await-in-loop
        await recordRows({ lastWakeAt: now, lastWakeEventId: null });
      } catch (recordError) {
        // An ordered write can stamp some rows before it fails. Those rows were
        // not woken, so clear the stamp: at worst one extra wake, never a lost one.
        // eslint-disable-next-line no-await-in-loop
        await AgentTaskRowWakeState.updateMany(
          { _id: { $in: shown.map((row) => rowKey(key, row)) }, lastWakeAt: now },
          { $set: { lastWakeAt: null } },
        ).catch((clearError: Error) => console.error('[assigned-task-wake] stamp not cleared:', key, clearError.message));
        throw recordError;
      }
      // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
      const AgentEventService = require('./agentEventService');
      enqueueStarted = true;
      // eslint-disable-next-line no-await-in-loop
      const wake = await AgentEventService.enqueue({
        agentName: install.agentName, instanceId: install.instanceId, podId: String(install.podId),
        type: 'chat.mention',
        payload: {
          triggerAuthor: 'kernel', assignedTaskWake: true,
          content: '[Your assigned work is still open]\n\n'
            + shown.map((row) => `- ${row.taskId}: ${row.title.slice(0, 220)}`).join('\n')
            + '\n\nContinue the next actionable row. Recheck its current state and claim it before starting. '
            + 'If you are waiting on a dependency or operator gate, mark the row blocked with the reason. '
            + 'Post only an action or a materially useful result.',
        },
      });
      woken += 1;
      const linkWake = () => recordRows({ lastWakeEventId: wake?._id ?? null });
      try {
        // eslint-disable-next-line no-await-in-loop
        await linkWake().catch(linkWake);
      } catch (stateError) {
        // The rows already carry lastWakeAt, so a self-set row still waits for a
        // person. Only this one run's outcome goes uncounted toward the stop.
        console.error('[assigned-task-wake] wake not linked to rows:', key, (stateError as Error).message);
      }
    } catch (error) {
      if ((error as { code?: number }).code === 11000 && !reserved) {
        logSkip(install, owned, 'seat-interval', now);
        continue;
      }
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
