import { classifyRuntime } from './agentStateService';
import { isHostedInstallation } from './hostedRuntimeService';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AgentInstallation } = require('../models/AgentRegistry');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AgentEvent = require('../models/AgentEvent');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AgentEventService = require('./agentEventService');

/**
 * A daily wake at a set time, for an agent that brings its own runtime.
 *
 * A BYO agent's only timed wake was the heartbeat, an interval with no time of
 * day, so a daily job needed a cron on someone's host to @mention it. One
 * schedule lives on each installation, so it belongs to one pod.
 *
 * It's delivered as a `heartbeat` event whose `payload.content` is the owner's
 * instruction. The CLI wrapper and OpenClaw already run that field as the
 * turn's prompt, so this needs no CLI release. The heartbeat setting itself is
 * untouched: a seat with its heartbeat off still gets its schedule.
 *
 * The dispatcher ticks every minute. A tick missed by a restart is caught up
 * inside CATCH_UP_MINUTES, and past that the day is skipped. An undelivered
 * wake isn't added to: a seat back after days runs its job once.
 *
 * `lastFiredAt` also lets the wake's post through the run cap
 * (AgentMessageService.owedScheduledPost): a daily post in a quiet pod is not
 * a monologue, and would stop on the fourth day.
 */

export const SCHEDULE_PROMPT_MAX_CHARS = 1000;
export const CATCH_UP_MINUTES = 60;
const MINUTES_PER_DAY = 24 * 60;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface AgentSchedule {
  enabled: boolean;
  time: string;
  timezone: string;
  prompt: string;
  lastFiredOn?: string;
  lastFiredAt?: Date;
}

const isTimeZone = (value: unknown): value is string => {
  if (typeof value !== 'string' || !value) return false;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

/** `{ enabled: false }` alone: stopping shouldn't need the rest of the schedule. */
export const isBareStop = (body: Record<string, unknown>): boolean => (
  body.enabled === false && [body.time, body.timezone, body.prompt].every((field) => field === undefined)
);

/** Names the first field a schedule write got wrong, or null when it's valid. */
export const invalidScheduleField = (body: Record<string, unknown>) => {
  if (typeof body.enabled !== 'boolean') {
    return { field: 'enabled', error: 'Invalid schedule: enabled must be true or false' };
  }
  if (isBareStop(body)) return null;
  if (typeof body.time !== 'string' || !TIME_RE.test(body.time)) {
    return { field: 'time', error: 'Invalid schedule: time must be HH:MM on a 24-hour clock' };
  }
  if (!isTimeZone(body.timezone)) {
    return { field: 'timezone', error: 'Invalid schedule: timezone must be an IANA name, such as America/Los_Angeles' };
  }
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt || prompt.length > SCHEDULE_PROMPT_MAX_CHARS) {
    return { field: 'prompt', error: `Invalid schedule: prompt must be 1 to ${SCHEDULE_PROMPT_MAX_CHARS} characters` };
  }
  return null;
};

/** Agents you run yourself. Commonly runs the others, under their own limits. */
export const takesSchedule = (installation: any): boolean => {
  const { isByo, isNative } = classifyRuntime(installation);
  return isByo && !isNative && !isHostedInstallation(installation);
};

const localClock = (now: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value || '';
  return {
    day: `${part('year')}-${part('month')}-${part('day')}`,
    minutes: Number(part('hour')) * 60 + Number(part('minute')),
  };
};

const dayBefore = (day: string): string => (
  new Date(Date.parse(`${day}T00:00:00Z`) - MINUTES_PER_DAY * 60 * 1000).toISOString().slice(0, 10)
);

/**
 * The local day whose wake is due at `now`, or null. A wake set near midnight
 * is still due just after it, against the day it was set for.
 */
export const dueDay = (schedule: Pick<AgentSchedule, 'time' | 'timezone'>, now: Date): string | null => {
  const [hours, minutes] = schedule.time.split(':').map(Number);
  const target = hours * 60 + minutes;
  const clock = localClock(now, schedule.timezone);
  if (clock.minutes >= target) {
    return clock.minutes - target <= CATCH_UP_MINUTES ? clock.day : null;
  }
  return clock.minutes + MINUTES_PER_DAY - target <= CATCH_UP_MINUTES ? dayBefore(clock.day) : null;
};

export const buildScheduleContent = (prompt: string, podId: unknown): string => [
  'Scheduled job, set by your owner. Do this now:',
  prompt,
  '',
  `Post the result in this pod (podId: ${String(podId)}). If there is nothing to report, return NO_REPLY.`,
].join('\n');

/**
 * Enqueues each due wake once. The day is claimed before the enqueue, so two
 * dispatchers can't both fire it, and handed back if the enqueue fails.
 */
export const dispatchSchedules = async (now: Date = new Date()): Promise<number> => {
  const rows = await AgentInstallation.find({ status: 'active', 'config.schedule.enabled': true })
    .select('agentName instanceId podId config.schedule config.runtime config.autonomy').lean();
  let enqueued = 0;
  for (const row of rows) {
    const schedule = row.config?.schedule as AgentSchedule | undefined;
    if (!schedule || !takesSchedule(row) || row.config?.autonomy?.enabled === false) continue;
    let day: string | null = null;
    try {
      day = dueDay(schedule, now);
    } catch (error) {
      console.warn(`[agent-schedule] ${row.agentName}: ${(error as Error).message}`);
    }
    if (!day || schedule.lastFiredOn === day) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const claim = await AgentInstallation.updateOne(
        {
          _id: row._id,
          status: 'active',
          'config.schedule.enabled': true,
          'config.schedule.prompt': schedule.prompt,
          'config.schedule.lastFiredOn': { $ne: day },
        },
        { $set: { 'config.schedule.lastFiredOn': day } },
      );
      if (!claim.modifiedCount) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        const undelivered = await AgentEvent.exists({
          agentName: row.agentName,
          instanceId: row.instanceId || 'default',
          podId: row.podId,
          type: 'heartbeat',
          status: 'pending',
          'payload.trigger': 'schedule',
        });
        if (undelivered) continue;
        // eslint-disable-next-line no-await-in-loop
        await AgentEventService.enqueue({
          agentName: row.agentName,
          instanceId: row.instanceId || 'default',
          podId: row.podId,
          type: 'heartbeat',
          payload: { trigger: 'schedule', content: buildScheduleContent(schedule.prompt, row.podId) },
        });
      } catch (error) {
        // Hand the day back, so the next tick tries again inside the catch-up.
        // eslint-disable-next-line no-await-in-loop
        await AgentInstallation.updateOne(
          { _id: row._id, 'config.schedule.lastFiredOn': day },
          schedule.lastFiredOn
            ? { $set: { 'config.schedule.lastFiredOn': schedule.lastFiredOn } }
            : { $unset: { 'config.schedule.lastFiredOn': 1 } },
        );
        throw error;
      }
      // eslint-disable-next-line no-await-in-loop
      await AgentInstallation.updateOne({ _id: row._id }, { $set: { 'config.schedule.lastFiredAt': now } });
      enqueued += 1;
    } catch (error) {
      console.error(`[agent-schedule] ${row.agentName} wake for ${day} failed:`, (error as Error).message);
    }
  }
  return enqueued;
};

export default { dispatchSchedules };
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
