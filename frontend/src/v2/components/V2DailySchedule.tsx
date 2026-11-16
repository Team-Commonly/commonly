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

const DAILY_SCHEDULE_TIME = '09:00';

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
  /** The server's answer (agentScheduleService.nextRunWhen); absent from an older backend. */
  nextRun?: 'now' | 'today' | 'tomorrow' | null;
}

// A refusal a retry can't change gets its own line, and the offer goes away.
type Refusal = 'notYours' | 'byoOnly' | 'notMember';
const refusalOf = (error: unknown): Refusal | null => {
  const response = (error as { response?: { status?: number; data?: { code?: string } } })?.response;
  if (response?.data?.code === 'schedule_byo_only') return 'byoOnly';
  // Starting a schedule needs a seat in the pod (manage-settings.ts), so an owner who left is told to join.
  if (response?.data?.code === 'not_pod_member') return 'notMember';
  if (response?.status === 403) return 'notYours';
  return null;
};

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

/** "Pacific Standard Time" rather than "America/Los_Angeles"; the IANA name when the browser has no words for it. */
export const formatTimeZone = (timeZone: string, locale: string, now: Date = new Date()): string => {
  try {
    return new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'long' }).formatToParts(now)
      .find((part) => part.type === 'timeZoneName')?.value || timeZone;
  } catch {
    return timeZone;
  }
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
  const [readFailed, setReadFailed] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
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
    setReadFailed(false);
    setRefused(null);
    void api.get<{ installations?: Array<{ podId: string; schedule?: SavedSchedule | null }> }>(settingsUrl(target))
      .then((data) => {
        if (!active) return;
        const row = (data?.installations || []).find((entry) => String(entry.podId) === String(podId));
        setSaved(row?.schedule || null);
      })
      // Unread, a save could overwrite a daily job it never named, so nothing is offered.
      .catch(() => { if (active) setReadFailed(true); });
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
    } catch (failure) {
      if (!live.current) return;
      const refusal = refusalOf(failure);
      if (refusal) setRefused(refusal);
      else setError(t(failedKey));
    } finally {
      if (live.current) setBusy(false);
    }
  }, [api, busy, podId, t, target]);

  if (!target) {
    return <p className="v2-chat__start-note" data-testid="daily-schedule-mention-only">{t('podChat.dailySchedule.mentionOnly')}</p>;
  }
  if (readFailed) return null;
  const name = target.displayName || target.agentName;
  if (refused) {
    return <p className="v2-chat__start-note" role="status" data-testid="daily-schedule-refused">{t(`podChat.dailySchedule.${refused}`, { name })}</p>;
  }
  const on = Boolean(saved?.enabled && saved.time && saved.timezone);
  const thisJob = on && (saved?.prompt || '').trim() === prompt.trim();

  if (on && thisJob) {
    const time = formatScheduleTime(saved!.time!, i18n.language);
    const zone = formatTimeZone(saved!.timezone!, i18n.language);
    const next = saved!.nextRun ? t('podChat.dailySchedule.next', { when: t(`podChat.dailySchedule.${saved!.nextRun}`, { time }) }) : '';
    return (
      <>
        <p className="v2-chat__start-note" role="status" data-testid="daily-schedule-on">
          {/* Chinese sentences sit flush after 。; English ones take a space. */}
          {[t('podChat.dailySchedule.on', { name, time, zone }), next].filter(Boolean)
            .join(i18n.language.startsWith('zh') ? '' : ' ')}
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
