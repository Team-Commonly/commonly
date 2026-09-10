// Artifacts — direction C, PR 5 (ScaleArtifacts.dc.html; Sharpen 66366 + 66376).
// Every file and page shared in your pods, newest first, from one query:
// GET /api/artifacts. The inspector's Files pane is the same query with
// podId fixed; this page is the query with podId as a filter.
import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import axios from 'axios';
import { getSignedAttachmentUrl } from '../../utils/signedAttachmentUrl';
import V2Lightbox from './V2Lightbox';

export type ArtifactKind = 'image' | 'page' | 'doc';
export interface ArtifactItem {
  id: string;
  fileName: string;
  name: string;
  contentType: string;
  kind: ArtifactKind;
  size: number | null;
  podId: string | null;
  podName: string | null;
  sharedBy: { id: string | null; username: string | null; displayName: string | null };
  createdAt: string | null;
}
interface ArtifactsResponse { items: ArtifactItem[]; nextCursor: string | null; total: number; limit: number }
interface PodRef { _id: string; name: string }

const KINDS: Array<{ key: '' | ArtifactKind; label: string }> = [
  { key: '', label: 'all' }, { key: 'image', label: 'images' }, { key: 'doc', label: 'docs' }, { key: 'page', label: 'pages' },
];

// The ext chip: the file's own extension, uppercase mono, bordered — never a colour square.
export const extOf = (name: string | null | undefined): string => {
  const m = /\.([a-z0-9]{1,5})$/i.exec(String(name || ''));
  return m ? m[1].toUpperCase() : 'FILE';
};

export const formatSize = (bytes: number | null | undefined): string => {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes; let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
};

// Same vocabulary as Activity: now / 32m / 6h / 2d — and mo past 30 days.
export const whenLabel = (value: string | null | undefined): string => {
  if (!value) return '';
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
};

// Pods carry a long descriptive title; the table names them by the short leading name.
export const shortPodName = (name: string | null | undefined): string => (
  (name || '').trim().split(/\s*[·—–:|]\s*/)[0].trim() || (name || '').trim()
);

const sharedByLabel = (item: ArtifactItem): string => item.sharedBy.displayName || item.sharedBy.username || '—';

const V2ArtifactsPage: React.FC = () => {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const podId = searchParams.get('podId') || '';
  const kind = (searchParams.get('kind') || '') as '' | ArtifactKind;
  const [q, setQ] = useState(searchParams.get('q') || '');
  const [pods, setPods] = useState<PodRef[]>([]);
  const [items, setItems] = useState<ArtifactItem[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [podMenuOpen, setPodMenuOpen] = useState(false);
  // ux-lead 66462: an image row opens the chat lightbox; pages and docs open in a new tab.
  const [lightbox, setLightbox] = useState<ArtifactItem | null>(null);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value); else next.delete(key);
    setSearchParams(next, { replace: true });
  };

  const headers = useMemo(() => {
    const token = localStorage.getItem('token');
    return token ? { Authorization: `Bearer ${token}` } : undefined;
  }, []);

  useEffect(() => {
    let active = true;
    axios.get<PodRef[]>('/api/pods', { headers })
      .then((res) => { if (active) setPods(Array.isArray(res.data) ? res.data : []); })
      .catch(() => { if (active) setPods([]); });
    return () => { active = false; };
  }, [headers]);

  // Debounce the search into the URL so a shared link carries the query.
  useEffect(() => {
    const handle = globalThis.window.setTimeout(() => { if ((searchParams.get('q') || '') !== q) setParam('q', q); }, 250);
    return () => globalThis.window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const urlQ = searchParams.get('q') || '';
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const params: Record<string, string | number> = { limit: 50 };
    if (podId) params.podId = podId;
    if (kind) params.kind = kind;
    if (urlQ) params.q = urlQ;
    axios.get<ArtifactsResponse>('/api/artifacts', { headers, params })
      .then((res) => {
        if (!active) return;
        setItems(res.data.items || []);
        setTotal(typeof res.data.total === 'number' ? res.data.total : (res.data.items || []).length);
        setNextCursor(res.data.nextCursor || null);
      })
      .catch(() => { if (active) { setError(t('artifacts.loadFailed')); setItems([]); setTotal(0); setNextCursor(null); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [headers, podId, kind, urlQ, t]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const params: Record<string, string | number> = { limit: 50, after: nextCursor };
      if (podId) params.podId = podId;
      if (kind) params.kind = kind;
      if (urlQ) params.q = urlQ;
      const res = await axios.get<ArtifactsResponse>('/api/artifacts', { headers, params });
      setItems((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...(res.data.items || []).filter((item) => !seen.has(item.id))];
      });
      setNextCursor(res.data.nextCursor || null);
    } catch {
      setError(t('artifacts.loadFailed'));
    } finally {
      setLoadingMore(false);
    }
  };

  const openItem = async (item: ArtifactItem) => {
    if (item.kind === 'image') { setLightbox(item); return; }
    const url = await getSignedAttachmentUrl(`/api/uploads/${item.fileName}`);
    if (url) globalThis.window.open(url, '_blank', 'noopener');
  };

  const scopedPods = pods;
  const selectedPod = scopedPods.find((pod) => pod._id === podId) || null;

  return (
    <div className="v2-artifacts">
      <header className="v2-artifacts__head">
        <div className="v2-artifacts__heading">
          <h1 className="v2-artifacts__title">{t('artifacts.title')}</h1>
          <span className="v2-artifacts__meta">{t('artifacts.meta')}</span>
        </div>
      </header>
      <div className="v2-artifacts__controls">
        <div className="v2-artifacts__seg" role="group" aria-label={t('artifacts.kindLabel')}>
          {KINDS.map((option) => (
            <button key={option.key || 'all'} type="button" className={`v2-artifacts__seg-button${kind === option.key ? ' v2-artifacts__seg-button--active' : ''}`} aria-pressed={kind === option.key} onClick={() => setParam('kind', option.key)}>
              {t(`artifacts.kinds.${option.label}`)}
            </button>
          ))}
        </div>
        <div className="v2-artifacts__seg" role="group" aria-label={t('artifacts.podLabel')} onKeyDown={(event) => { if (event.key === 'Escape') setPodMenuOpen(false); }}>
          <button type="button" className={`v2-artifacts__seg-button${!podId ? ' v2-artifacts__seg-button--active' : ''}`} aria-pressed={!podId} onClick={() => { setParam('podId', ''); setPodMenuOpen(false); }}>{t('artifacts.allPods')}</button>
          {scopedPods.slice(0, 2).map((pod) => (
            <button key={pod._id} type="button" className={`v2-artifacts__seg-button${podId === pod._id ? ' v2-artifacts__seg-button--active' : ''}`} aria-pressed={podId === pod._id} onClick={() => { setParam('podId', pod._id); setPodMenuOpen(false); }}>{shortPodName(pod.name)}</button>
          ))}
          {scopedPods.length > 2 && (
            <button type="button" className={`v2-artifacts__seg-button${scopedPods.slice(2).some((pod) => pod._id === podId) ? ' v2-artifacts__seg-button--active' : ''}`} aria-expanded={podMenuOpen} onClick={() => setPodMenuOpen((open) => !open)}>
              {selectedPod && scopedPods.slice(2).some((pod) => pod._id === podId) ? shortPodName(selectedPod.name) : t('artifacts.morePods')}
            </button>
          )}
          {podMenuOpen && (
            <div className="v2-artifacts__seg-menu" role="listbox" aria-label={t('artifacts.podLabel')}>
              {scopedPods.slice(2).map((pod) => (
                <button key={pod._id} type="button" role="option" aria-selected={podId === pod._id} className={`v2-artifacts__seg-button v2-artifacts__seg-button--menu${podId === pod._id ? ' v2-artifacts__seg-button--active' : ''}`} onClick={() => { setParam('podId', pod._id); setPodMenuOpen(false); }}>{shortPodName(pod.name)}</button>
              ))}
            </div>
          )}
        </div>
        <label className="v2-artifacts__search">
          <input type="search" value={q} placeholder={t('artifacts.searchPlaceholder')} aria-label={t('artifacts.searchPlaceholder')} onChange={(event) => setQ(event.target.value)} />
          <span className="v2-artifacts__search-key" aria-hidden="true">⌘K</span>
        </label>
      </div>

      {error && <div className="v2-artifacts__error" role="alert">{error}</div>}
      {loading && !error && <div className="v2-artifacts__loading"><span className="v2-spinner" /></div>}
      {!loading && !error && items.length === 0 && (
        <div className="v2-artifacts__empty">{urlQ || kind || podId ? t('artifacts.emptyFiltered') : t('artifacts.empty')}</div>
      )}
      {!loading && items.length > 0 && (
        <div className="v2-artifacts__table-wrap">
          <table className="v2-artifacts__table">
            <thead>
              <tr>
                <th scope="col">{t('artifacts.columns.file')}</th>
                <th scope="col">{t('artifacts.columns.kind')}</th>
                <th scope="col">{t('artifacts.columns.pod')}</th>
                <th scope="col">{t('artifacts.columns.sharedBy')}</th>
                <th scope="col">{t('artifacts.columns.when')}</th>
                <th scope="col">{t('artifacts.columns.size')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="v2-artifacts__row">
                  <td>
                    <div className="v2-artifacts__file">
                      <span className="v2-artifacts__ext" aria-hidden="true">{extOf(item.name)}</span>
                      <button type="button" className="v2-artifacts__name" onClick={() => { void openItem(item); }}>{item.name}</button>
                      {/* ≤760 (66462 miss 2): the pod folds under the name as a mono line; the pod column hides. */}
                      <span className="v2-artifacts__pod-line">{shortPodName(item.podName)}</span>
                    </div>
                  </td>
                  <td className="v2-artifacts__mono">{t(`artifacts.kindNames.${item.kind}`)}</td>
                  <td>{shortPodName(item.podName)}</td>
                  <td>{sharedByLabel(item)}</td>
                  <td className="v2-artifacts__mono">{whenLabel(item.createdAt)}</td>
                  <td className="v2-artifacts__mono">{item.kind === 'page' ? '—' : formatSize(item.size)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {lightbox && <V2Lightbox images={[{ src: `/api/uploads/${lightbox.fileName}`, name: lightbox.name }]} index={0} onClose={() => setLightbox(null)} />}
      {!loading && items.length > 0 && (
        <div className="v2-artifacts__foot">
          <span className="v2-artifacts__mono">{t('artifacts.foot', { shown: items.length, total })}</span>
          {nextCursor && <button type="button" className="v2-artifacts__more" onClick={() => { void loadMore(); }} disabled={loadingMore}>{loadingMore ? t('artifacts.loadingMore') : t('artifacts.more', { count: Math.max(total - items.length, 0) })}</button>}
        </div>
      )}
    </div>
  );
};

export default V2ArtifactsPage;
