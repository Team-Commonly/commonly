import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useV2Api } from '../hooks/useV2Api';
import './V2BringTeammate.css';

export type TeammateInviteSource = 'first-agent-post' | 'scout-first-session' | 'solo-pod';
interface InviteLink {
  token: string;
  source?: string;
  createdBy?: string | { _id?: string };
  expiresAt?: string | null;
  maxUses?: number | null;
  uses?: number;
}
interface Props {
  podId: string;
  podName: string;
  userId: string;
  source: TeammateInviteSource;
  agentName?: string;
  enabled?: boolean;
  /** Called when the card appears, so a thread at its end can keep the card in view. */
  onShown?: () => void;
  /** Keep request state above transcript slots that move during thread toggles. */
  children?: (card: React.ReactNode) => React.ReactNode;
}

/** State and pending requests belong to one viewer/pod/placement. */
const BringTeammateContent: React.FC<Props> = ({
  podId, podName, userId, source, agentName, enabled = true, onShown, children,
}) => {
  const { t } = useTranslation();
  const api = useV2Api();
  const apiRef = useRef(api);
  apiRef.current = api;
  const storageKey = `v2.teammate.${podId}.${source}`;
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(storageKey) === '1'; } catch { return false; }
  });
  const [url, setUrl] = useState('');
  const [copyBusy, setCopyBusy] = useState(false);
  const [state, setState] = useState<'idle' | 'creating' | 'copied' | 'manual' | 'error'>('idle');
  const field = useRef<HTMLInputElement>(null);
  const active = useRef(true);
  const generation = useRef(0);
  const busy = useRef(false);
  const lookup = useRef<Promise<string> | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>();

  const readExisting = useCallback(async () => {
    const rows = await apiRef.current.get<InviteLink[]>(`/api/pods/${podId}/invites`);
    const existing = rows.find((row) => {
      const creator = typeof row.createdBy === 'string' ? row.createdBy : row.createdBy?._id;
      return creator === userId && row.source === source && /^[a-f0-9]{32}$/.test(row.token)
        && (!row.expiresAt || Date.parse(row.expiresAt) > Date.now())
        && (row.maxUses == null || (row.uses || 0) < row.maxUses);
    });
    return existing ? `${window.location.origin}/v2/invite/${existing.token}` : '';
  }, [podId, source, userId]);

  useEffect(() => {
    generation.current += 1;
    active.current = !dismissed;
    lookup.current = null;
    return () => {
      active.current = false;
      clearTimeout(copiedTimer.current);
    };
  }, [dismissed, readExisting]);

  useEffect(() => {
    if (!enabled || dismissed || lookup.current) return;
    const epoch = generation.current;
    const request = readExisting();
    lookup.current = request;
    // Visibility changes do not cancel a press while its thread slot moves.
    // Scope changes and explicit dismissal still invalidate the request.
    void request.then((existing) => {
      if (active.current && generation.current === epoch && lookup.current === request) setUrl(existing);
    }).catch(() => { if (generation.current === epoch && lookup.current === request) lookup.current = null; });
  }, [enabled, dismissed, readExisting]);

  useEffect(() => {
    if (state === 'manual') { field.current?.focus(); field.current?.select(); }
  }, [state]);

  const copy = async () => {
    if (busy.current) return;
    busy.current = true;
    setCopyBusy(true);
    const epoch = generation.current;
    const stillHere = () => active.current && generation.current === epoch;
    setState(url ? 'idle' : 'creating');
    clearTimeout(copiedTimer.current);
    let destination = url;
    try {
      if (!destination) {
        if (!lookup.current) lookup.current = readExisting();
        destination = await lookup.current;
        if (!stillHere()) return;
        if (!destination) {
          const created = await apiRef.current.post<{ token: string }>(`/api/pods/${podId}/invites`, {
            expiresInHours: 168, maxUses: null, source,
          });
          if (!/^[a-f0-9]{32}$/.test(created.token)) throw new Error('invalid invite token');
          destination = `${window.location.origin}/v2/invite/${created.token}`;
        }
      }
      if (!stillHere()) return;
      setUrl(destination);
      lookup.current = Promise.resolve(destination);
      try {
        await navigator.clipboard.writeText(destination);
        if (!stillHere()) return;
        setState('copied');
        copiedTimer.current = setTimeout(() => setState('idle'), 2000);
      } catch {
        if (stillHere()) {
          setState('manual');
          field.current?.focus(); field.current?.select();
        }
      }
    } catch {
      // A lost POST response is recovered through GET on the next press.
      lookup.current = null;
      if (stillHere()) setState('error');
    } finally {
      busy.current = false;
      if (stillHere()) setCopyBusy(false);
    }
  };

  const body = source === 'first-agent-post' ? 'agentPost' : source === 'scout-first-session' ? 'scout' : 'solo';
  const label = state === 'creating' ? 'creating' : state === 'copied' ? 'copied'
    : state === 'manual' ? 'copyRetry' : state === 'error' ? 'retry' : 'act';
  const shown = enabled && !dismissed;
  const onShownRef = useRef(onShown);
  onShownRef.current = onShown;
  useEffect(() => {
    if (shown) onShownRef.current?.();
  }, [shown]);
  const card = shown ? (
    <section className={`v2-teammate${source === 'solo-pod' ? ' v2-teammate--empty' : ' v2-teammate--message'}`} aria-label={t('teammate.title', { podName })}>
      <div className="v2-teammate__kicker">{t('teammate.kicker')}</div>
      <h3>{t('teammate.title', { podName })}</h3>
      <p className="v2-teammate__body">{t(`teammate.body.${body}`, { agentName })}</p>
      <div className="v2-teammate__acts">
        <button type="button" className={`v2-teammate__copy${state === 'copied' || state === 'creating' ? ' v2-teammate__copy--quiet' : ''}`}
          onClick={() => { void copy(); }} disabled={copyBusy} aria-busy={copyBusy || undefined}>
          {state === 'copied' && <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>}
          {t(`teammate.${label}`)}
        </button>
        <button type="button" className="v2-teammate__dismiss" aria-label={t('teammate.dismiss')} onClick={() => {
          setDismissed(true);
          try { localStorage.setItem(storageKey, '1'); } catch { /* This mount still dismisses. */ }
        }}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
        </button>
      </div>
      {url && <div className="v2-teammate__link">
        <input ref={field} readOnly value={url} aria-label={t('teammate.act')} className={state === 'manual' ? 'v2-teammate__manual' : ''} onFocus={(event) => event.currentTarget.select()} />
        <p>{t(state === 'manual' ? 'teammate.clipboardFail' : 'teammate.meta')}</p>
      </div>}
      {state === 'error' && <p className="v2-teammate__error" role="alert">{t('teammate.error')}</p>}
      <span className="v2-teammate__live" role="status" aria-live="polite">{state === 'copied' ? t('teammate.live') : ''}</span>
    </section>
  ) : null;
  return children ? <>{children(card)}</> : card;
};
const V2BringTeammate: React.FC<Props> = (props) => (
  <BringTeammateContent key={`${props.podId}.${props.userId}.${props.source}`} {...props} />
);
export default V2BringTeammate;
