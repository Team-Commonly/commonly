import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useV2Api } from '../hooks/useV2Api';

/**
 * Scout's recurring-workflow proposal, offered as a daily run on the owner's
 * own connected agent. It uses the install's existing daily schedule
 * (agentScheduleService: one per pod, BYO agents only), so it says "every day"
 * and never "weekly", shows when the next run is, and turns off in one click.
 * With no own agent connected here it says how the work runs instead.
 */

export const DAILY_SCHEDULE_TIME = '09:00';

export interface ScheduleTarget {
  agentName: string;
  instanceId: string;
  displayName?: string;
}

interface SavedSchedule {
  enabled: boolean;
  time?: string;
  timezone?: string;
  prompt?: string;
}

interface Props {
  api: ReturnType<typeof useV2Api>;
  podId: string;
  prompt: string;
  /** The owner's own connected agent in this pod, or null when there is none. */
  target: ScheduleTarget | null;
}

const viewerTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

const clockIn = (now: Date, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value || 0);
  return part('hour') * 60 + part('minute');
};

/** Today or tomorrow, from the schedule's own clock. The dispatcher runs it at that local time. */
export const nextRunDay = (time: string, timeZone: string, now: Date = new Date()): 'today' | 'tomorrow' => {
  const [hours, minutes] = time.split(':').map(Number);
  return clockIn(now, timeZone) < hours * 60 + minutes ? 'today' : 'tomorrow';
};

/** 09:00 in the reader's own clock style: "9:00 AM", or "09:00". */
export const formatScheduleTime = (time: string, locale: string): string => {
  const [hours, minutes] = time.split(':').map(Number);
  try {
    return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })
      .format(new Date(Date.UTC(2000, 0, 1, hours, minutes)));
  } catch {
    return time;
  }
};

const settingsUrl = (target: ScheduleTarget) => `/api/registry/agents/${encodeURIComponent(target.agentName)}`
  + `/manage-settings?instanceId=${encodeURIComponent(target.instanceId || 'default')}`;
const scheduleUrl = (target: ScheduleTarget, podId: string) => `/api/registry/agents/${encodeURIComponent(target.agentName)}`
  + `/manage-settings/pods/${encodeURIComponent(podId)}/schedule?instanceId=${encodeURIComponent(target.instanceId || 'default')}`;

const V2DailySchedule: React.FC<Props> = ({ api, podId, prompt, target }) => {
  const { t, i18n } = useTranslation();
  const [saved, setSaved] = useState<SavedSchedule | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  // Re-armed on every mount: StrictMode mounts twice, and a ref left false drops each save's answer.
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  const targetKey = target ? `${target.agentName}:${target.instanceId}` : '';
  useEffect(() => {
    if (!target) return undefined;
    let active = true;
    setSaved(undefined);
    void api.get<{ installations?: Array<{ podId: string; schedule?: SavedSchedule | null }> }>(settingsUrl(target))
      .then((data) => {
        if (!active) return;
        const row = (data?.installations || []).find((entry) => String(entry.podId) === String(podId));
        setSaved(row?.schedule || null);
      })
      // An unreadable state still offers the run; saving reports its own failure.
      .catch(() => { if (active) setSaved(null); });
    return () => { active = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, podId, targetKey]);

  const save = useCallback(async (body: Record<string, unknown>, failedKey: string) => {
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    try {
      const data = await api.put<{ settings?: { schedule?: SavedSchedule | null } }>(scheduleUrl(target, podId), body);
      if (live.current) setSaved(data?.settings?.schedule ?? { enabled: body.enabled === true });
    } catch {
      if (live.current) setError(t(failedKey));
    } finally {
      if (live.current) setBusy(false);
    }
  }, [api, busy, podId, t, target]);

  if (!target) {
    return <p className="v2-chat__start-note" data-testid="daily-schedule-mention-only">{t('podChat.dailySchedule.mentionOnly')}</p>;
  }
  const name = target.displayName || target.agentName;
  const on = Boolean(saved?.enabled && saved.time && saved.timezone);
  const thisJob = on && (saved?.prompt || '').trim() === prompt.trim();

  if (on && thisJob) {
    const time = formatScheduleTime(saved!.time!, i18n.language);
    const when = t(`podChat.dailySchedule.${nextRunDay(saved!.time!, saved!.timezone!)}`, { time });
    return (
      <>
        <p className="v2-chat__start-note" role="status" data-testid="daily-schedule-on">
          {t('podChat.dailySchedule.on', { name, time, timezone: saved!.timezone, when })}
        </p>
        <button type="button" className="v2-chat__start" disabled={busy}
          onClick={() => { void save({ enabled: false }, 'podChat.dailySchedule.offFailed'); }}>
          {t('podChat.dailySchedule.turnOff')}
        </button>
        {error && <p className="v2-chat__start-note v2-chat__start-note--error" role="alert">{error}</p>}
      </>
    );
  }

  const time = formatScheduleTime(DAILY_SCHEDULE_TIME, i18n.language);
  return (
    <>
      <button type="button" className="v2-chat__start" disabled={busy || saved === undefined}
        data-testid="daily-schedule-start"
        onClick={() => {
          void save({ enabled: true, time: DAILY_SCHEDULE_TIME, timezone: viewerTimeZone(), prompt },
            'podChat.dailySchedule.failed');
        }}>
        {t(on ? 'podChat.dailySchedule.replace' : 'podChat.dailySchedule.start', { name, time })}
      </button>
      {on && (
        <p className="v2-chat__start-note">
          {t('podChat.dailySchedule.otherJob', { name, time: formatScheduleTime(saved!.time!, i18n.language) })}
        </p>
      )}
      {error && <p className="v2-chat__start-note v2-chat__start-note--error" role="alert">{error}</p>}
    </>
  );
};

export default V2DailySchedule;
