import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import axios from 'axios';

// Sam's 2026-09-01 ruling: a constant TL;DR of what the agents are doing,
// living where the question is actually felt — pinned above the messages of
// the pod being read (Activity stays the cross-pod view). Backed entirely by
// the existing summaries surface: GET /api/summaries/pod/:podId (latest,
// visibility-gated) and POST .../refresh (rate-limited, falls back to a
// non-agent summary when no summarizer seat is installed).

interface PodSummary {
  content?: string;
  createdAt?: string;
}

interface Props {
  podId: string;
}

const relTime = (
  iso: string | undefined,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string => {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return '';
  const min = Math.floor(ms / 60000);
  if (min < 1) return t('podChat.catchup.justNow');
  if (min < 60) return t('podChat.catchup.minutesAgo', { count: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t('podChat.catchup.hoursAgo', { count: hr });
  return t('podChat.catchup.daysAgo', { count: Math.floor(hr / 24) });
};

const V2CatchUpStrip: React.FC<Props> = ({ podId }) => {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<PodSummary | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSummary(null);
    setLoaded(false);
    setExpanded(false);
    axios.get(`/api/summaries/pod/${podId}`)
      .then((res) => {
        if (cancelled) return;
        setSummary(res.data && res.data.content ? res.data : null);
        setLoaded(true);
      })
      .catch(() => {
        // Advisory surface: a failed summary read never blocks the chat.
        if (!cancelled) setLoaded(true);
      });
    return () => { cancelled = true; };
  }, [podId]);

  const handleRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const res = await axios.post(`/api/summaries/pod/${podId}/refresh`, {});
      const next = res.data?.summary;
      if (next && next.content) {
        setSummary(next);
        setExpanded(true);
      }
    } catch {
      // Rate-limited or failed — keep whatever we have.
    } finally {
      setRefreshing(false);
    }
  }, [podId, refreshing]);

  // Dismissal is per summary VERSION: dismissing hides this summary, and the
  // strip returns only when a newer one exists. localStorage per the browser
  // storage rules — wrapped, and absence just means "not dismissed".
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    try {
      setDismissed(window.localStorage.getItem(`v2.catchup.dismissed.${podId}`) === (summary?.createdAt || ''));
    } catch { setDismissed(false); }
  }, [podId, summary]);
  const handleDismiss = useCallback(() => {
    try { window.localStorage.setItem(`v2.catchup.dismissed.${podId}`, summary?.createdAt || ''); } catch { /* per-viewer convenience only */ }
    setDismissed(true);
  }, [podId, summary]);

  if (!loaded) return null;
  // Sam's revised ruling (2026-09-01, hours after the strip shipped):
  // "always shows up is not a good design" and an empty/stale strip
  // "reveals no good info". So the strip EARNS its row: it renders only
  // when a summary exists, is fresh (24h), and this version has not been
  // dismissed. No summary -> no strip, not an empty shell with a
  // Summarize button — generating one on demand stays available from the
  // inspector/summaries surface.
  const FRESH_MS = 24 * 60 * 60 * 1000;
  const isFresh = !!(summary?.createdAt && Date.now() - new Date(summary.createdAt).getTime() < FRESH_MS);
  if (!summary?.content || !isFresh || dismissed) return null;

  return (
    <div className="v2-catchup" data-testid="catchup-strip">
      <div className="v2-catchup__row">
        <button
          type="button"
          className="v2-catchup__toggle"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          disabled={!summary}
        >
          <span className={`v2-catchup__chevron${expanded ? ' v2-catchup__chevron--open' : ''}`} aria-hidden="true">▸</span>
          {t('podChat.catchup.title')}
          {summary?.createdAt && (
            <span className="v2-catchup__time"> · {relTime(summary.createdAt, t)}</span>
          )}
        </button>
        {!expanded && (
          <span className="v2-catchup__snippet">
            {summary?.content
              ? summary.content.replace(/\s+/g, ' ').trim()
              : t('podChat.catchup.empty')}
          </span>
        )}
        <button
          type="button"
          className="v2-catchup__refresh"
          onClick={handleRefresh}
          disabled={refreshing}
        >
          {refreshing
            ? t('podChat.catchup.working')
            : t('podChat.catchup.refresh')}
        </button>
        <button
          type="button"
          className="v2-catchup__dismiss"
          onClick={handleDismiss}
          aria-label={t('podChat.catchup.dismiss')}
          title={t('podChat.catchup.dismiss')}
        >
          ×
        </button>
      </div>
      {expanded && summary?.content && (
        <div className="v2-catchup__body" data-testid="catchup-body">{summary.content}</div>
      )}
    </div>
  );
};

export default V2CatchUpStrip;
