// Artifacts, d215 #s-artifacts-signal (approved 11-03, D242).
// Every file and page shared in your pods, newest first, from one query:
// GET /api/artifacts. The inspector's Files pane is the same query with
// podId fixed; this page is the query with podId as a filter. Rows group by
// pod in the order the query returns them, so pods sort by their newest file.
import React, { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import axios from 'axios';
import { getSignedAttachmentUrl } from '../../utils/signedAttachmentUrl';
import V2Lightbox from './V2Lightbox';
import V2Segmented from './V2Segmented';
import { usePhone } from '../connectors/usePhone';
import { compactAge, compactNow } from '../utils/compactTime';
import './V2ArtifactsPage.css';

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
interface PodRef { _id: string; name: string; createdAt?: string }

const KINDS: Array<{ key: '' | ArtifactKind; label: string }> = [
  { key: '', label: 'all' }, { key: 'image', label: 'images' }, { key: 'doc', label: 'docs' }, { key: 'page', label: 'pages' },
];

// The type badge: the file's own extension, uppercase mono on a grey key, never a colour square.
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
  if (minutes < 1) return compactNow();
  if (minutes < 60) return compactAge('minute', minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return compactAge('hour', hours);
  const days = Math.floor(hours / 24);
  if (days < 30) return compactAge('day', days);
  return compactAge('month', Math.floor(days / 30));
};

// Pods carry a long descriptive title; the page names them by the short leading name.
export const shortPodName = (name: string | null | undefined): string => (
  (name || '').trim().split(/\s*[·—–:|]\s*/)[0].trim() || (name || '').trim()
);

export interface ArtifactGroup { key: string; name: string; items: ArtifactItem[] }
// One group per pod, in first-seen order. The list arrives newest first, so each group is newest
// first and the groups run by their newest file; a second page appends into the groups it reaches.
export const groupByPod = (list: ArtifactItem[]): ArtifactGroup[] => {
  const groups = new Map<string, ArtifactGroup>();
  list.forEach((item) => {
    const key = item.podId || '';
    let group = groups.get(key);
    if (!group) { group = { key, name: shortPodName(item.podName) || '—', items: [] }; groups.set(key, group); }
    group.items.push(item);
  });
  return [...groups.values()];
};

const artifactsQueryKey = (podId: string, kind: string, q: string): string => JSON.stringify([podId, kind, q]);
const UNFILTERED = artifactsQueryKey('', '', '');
// The shell trades the rail for the tab bar at this width; the page head becomes the 52px bar.
const PHONE_QUERY = '(max-width: 760px)';

const sharedByLabel = (item: ArtifactItem): string => item.sharedBy.displayName || item.sharedBy.username || '—';
const sizeLabel = (item: ArtifactItem): string => (item.kind === 'page' ? '—' : formatSize(item.size));

// The d215 sprite glyphs this page draws, at the artboard's stroke.
const PATHS = {
  layers: <><path d="M12 2 2 7l10 5 10-5-10-5z" /><path d="m2 17 10 5 10-5" /><path d="m2 12 10 5 10-5" /></>,
  file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M16 13H8M16 17H8" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  chev: <path d="m6 9 6 6 6-6" />,
  down: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
  open: <path d="M7 17 17 7M8 7h9v9" />,
} as const;
const Glyph: React.FC<{ name: keyof typeof PATHS }> = ({ name }) => (
  <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{PATHS[name]}</svg>
);

// Saves the file under its own name (CJK included). The bytes come through the same signed URL
// the open path mints; when the blob read fails (CORS, network), the signed URL opens instead,
// and the server's Content-Disposition decides between showing and saving.
const saveFile = async (item: ArtifactItem): Promise<void> => {
  const url = await getSignedAttachmentUrl(`/api/uploads/${item.fileName}`);
  if (!url) return;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download ${res.status}`);
    const href = URL.createObjectURL(await res.blob());
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = item.name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    globalThis.window.setTimeout(() => URL.revokeObjectURL(href), 0);
  } catch {
    globalThis.window.open(url, '_blank', 'noopener');
  }
};

const V2ArtifactsPage: React.FC = () => {
  const { t } = useTranslation();
  const phone = usePhone(PHONE_QUERY);
  const [searchParams, setSearchParams] = useSearchParams();
  const podId = searchParams.get('podId') || '';
  const kind = (searchParams.get('kind') || '') as '' | ArtifactKind;
  const [q, setQ] = useState(searchParams.get('q') || '');
  const [searchOpen, setSearchOpen] = useState(false);
  const [pods, setPods] = useState<PodRef[]>([]);
  const [items, setItems] = useState<ArtifactItem[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The query the shown result answers. Until a new one lands, items and total still belong to
  // the previous filter, so day zero must not read them as the unfiltered answer.
  const [loadedQuery, setLoadedQuery] = useState<string | null>(null);
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
    const queryKey = artifactsQueryKey(podId, kind, urlQ);
    const params: Record<string, string | number> = { limit: 50 };
    if (podId) params.podId = podId;
    if (kind) params.kind = kind;
    if (urlQ) params.q = urlQ;
    axios.get<ArtifactsResponse>('/api/artifacts', { headers, params })
      .then((res) => {
        if (!active) return;
        setItems(res.data.items || []);
        setLoadedQuery(queryKey);
        setTotal(typeof res.data.total === 'number' ? res.data.total : (res.data.items || []).length);
        setNextCursor(res.data.nextCursor || null);
      })
      .catch(() => { if (active) { setError(t('artifacts.loadFailed')); setItems([]); setTotal(0); setNextCursor(null); setLoadedQuery(queryKey); } })
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

  // Day zero: nothing shared and nothing filtered, so there is nothing to filter — no controls,
  // no count, one quiet row. A filtered empty result keeps the controls, and so does the render
  // between clearing a filter and its answer landing (the result is still the filtered one), or
  // the controls unmount under the person's focus. A search typed before its debounce reaches
  // the URL counts too, or the input unmounts mid-word.
  const dayZero = !loading && !error && total === 0 && items.length === 0 && !q && !urlQ && !kind && !podId
    && loadedQuery === UNFILTERED;
  // The row's key opens the account's oldest pod: signup creates My Workspace first. /api/pods
  // lists by last update, so pick by createdAt rather than position.
  const workspacePod = useMemo(() => {
    const createdMs = (pod: PodRef) => (pod.createdAt ? Date.parse(pod.createdAt) : Number.POSITIVE_INFINITY);
    return pods.reduce<PodRef | null>((oldest, pod) => (!oldest || createdMs(pod) < createdMs(oldest) ? pod : oldest), null);
  }, [pods]);

  const groups = useMemo(() => groupByPod(items), [items]);

  const openItem = async (item: ArtifactItem) => {
    if (item.kind === 'image') { setLightbox(item); return; }
    const url = await getSignedAttachmentUrl(`/api/uploads/${item.fileName}`);
    if (url) globalThis.window.open(url, '_blank', 'noopener');
  };

  // "14 files · 2 pods". The API counts files, not pods, so the pod count shows only once every
  // file is loaded and the groups on screen are the whole answer.
  const meta = loading || dayZero ? null : [
    t('artifacts.fileCount', { count: total }),
    !nextCursor && !error ? t('artifacts.podCount', { count: groups.length }) : null,
  ].filter(Boolean).join(' · ');

  const searchField = (
    <label className="v2a-search">
      <Glyph name="search" />
      <input type="search" value={q} placeholder={t('artifacts.searchPlaceholder')} aria-label={t('artifacts.searchPlaceholder')} onChange={(event) => setQ(event.target.value)} />
      <span className="v2a-kb" aria-hidden="true">⌘K</span>
    </label>
  );
  const kindSeg = (
    <V2Segmented<'' | ArtifactKind>
      className="v2a-seg"
      ariaLabel={t('artifacts.kindLabel')}
      value={kind}
      onChange={(value) => setParam('kind', value)}
      options={KINDS.map((option) => ({ value: option.key, label: t(`artifacts.kinds.${option.label}`) }))}
    />
  );
  // A pod id in the URL that /api/pods does not list (yet) still reads as chosen.
  const podOptions = podId && !pods.some((pod) => pod._id === podId) ? [...pods, { _id: podId, name: podId }] : pods;
  const podSel = (
    <label className="v2a-sel">
      <select value={podId} aria-label={t('artifacts.podLabel')} onChange={(event) => setParam('podId', event.target.value)}>
        <option value="">{t('artifacts.allPods')}</option>
        {podOptions.map((pod) => <option key={pod._id} value={pod._id}>{shortPodName(pod.name)}</option>)}
      </select>
      <Glyph name="chev" />
    </label>
  );
  const showSearch = !phone || searchOpen || Boolean(q);

  return (
    <div className="v2a">
      <header className="v2a-head">
        <h1 className="v2a-title">{t('artifacts.title')}</h1>
        {meta && <span className="v2a-meta">{meta}</span>}
        <span className="v2a-sp" />
        {!dayZero && !phone && (
          <>
            {searchField}
            {kindSeg}
            {podSel}
          </>
        )}
        {!dayZero && phone && (
          <button
            type="button"
            className="v2p-b v2p-b-g v2p-ib v2a-searchkey"
            aria-label={t('artifacts.searchPlaceholder')}
            aria-expanded={showSearch}
            onClick={() => setSearchOpen((open) => !open)}
          >
            <Glyph name="search" />
          </button>
        )}
      </header>

      <div className="v2a-body">
        <div className="v2a-col">
          {!dayZero && phone && (
            <>
              {showSearch && searchField}
              <div className="v2a-ctl">{kindSeg}{podSel}</div>
            </>
          )}

          {error && <div className="v2p-list"><div className="v2a-row v2a-row--one" role="alert"><Glyph name="file" /><div className="v2a-tx v2a-tx--plain">{error}</div></div></div>}
          {loading && !error && <div className="v2a-loading"><span className="v2-spinner" /></div>}
          {dayZero && (
            <div className="v2p-list">
              <div className={`v2a-row ${phone ? 'v2a-row--open' : 'v2a-row--one'}`}>
                <Glyph name="file" />
                <div>
                  <p className="v2a-tx v2a-tx--plain">{t('artifacts.dayZero.body')}</p>
                  {phone && workspacePod && (
                    <div className="v2a-keys">
                      <Link className="v2p-b v2p-b-s v2a-open" to={`/v2/pods/${workspacePod._id}`}>{t('artifacts.dayZero.open', { pod: workspacePod.name })}</Link>
                    </div>
                  )}
                </div>
                {!phone && workspacePod && (
                  <span className="v2a-ac">
                    <Link className="v2p-b v2p-b-s v2p-b-sm v2a-open" to={`/v2/pods/${workspacePod._id}`}>{t('artifacts.dayZero.open', { pod: workspacePod.name })}</Link>
                  </span>
                )}
              </div>
            </div>
          )}
          {!loading && !error && items.length === 0 && (urlQ || kind || podId) && (
            <div className="v2p-list"><p className="v2a-empty">{t('artifacts.emptyFiltered')}</p></div>
          )}
          {!loading && groups.map((group) => (
            <section key={group.key} className="v2a-group" aria-label={group.name}>
              <h2 className="v2p-gtitle v2a-gtitle"><Glyph name="layers" />{group.name}</h2>
              <ul className="v2p-list v2a-list">
                {group.items.map((item) => {
                  const size = sizeLabel(item);
                  return (
                    <li key={item.id} className="v2a-row v2a-file">
                      <span className="v2a-ext" aria-hidden="true">{extOf(item.name)}</span>
                      <div className="v2a-main">
                        <button type="button" className="v2a-name" onClick={() => { void openItem(item); }}>{item.name}</button>
                        <div className="v2a-sn">
                          {sharedByLabel(item)} · {whenLabel(item.createdAt)}
                          {phone && size !== '—' && <> · <span className="v2a-mo">{size}</span></>}
                        </div>
                      </div>
                      <span className="v2a-ac">
                        <span className="v2a-hv">
                          {!phone && (
                            <button type="button" className="v2p-b v2p-b-g v2p-ib v2p-b-sm" title={t('artifacts.open')} aria-label={t('artifacts.openFile', { name: item.name })} onClick={() => { void openItem(item); }}>
                              <Glyph name="open" />
                            </button>
                          )}
                          <button type="button" className={`v2p-b v2p-b-g v2p-ib${phone ? '' : ' v2p-b-sm'}`} title={t('artifacts.download')} aria-label={t('artifacts.downloadFile', { name: item.name })} onClick={() => { void saveFile(item); }}>
                            <Glyph name="down" />
                          </button>
                        </span>
                        {!phone && <span className="v2a-mo v2a-size">{size}</span>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          {!loading && items.length > 0 && (
            <div className="v2a-foot">
              <span className="v2a-mo">{t('artifacts.foot', { shown: items.length, total })}</span>
              {nextCursor && <button type="button" className="v2p-b v2p-b-g v2p-b-sm v2a-more" onClick={() => { void loadMore(); }} disabled={loadingMore}>{loadingMore ? t('artifacts.loadingMore') : t('artifacts.more', { count: Math.max(total - items.length, 0) })}</button>}
            </div>
          )}
        </div>
      </div>
      {lightbox && <V2Lightbox images={[{ src: `/api/uploads/${lightbox.fileName}`, name: lightbox.name }]} index={0} onClose={() => setLightbox(null)} />}
    </div>
  );
};

export default V2ArtifactsPage;
