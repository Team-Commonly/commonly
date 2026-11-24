// v2-native pod context inspector, /v2/dev/pod-context (admin only). It
// replaces the MUI PodContextDevPage with the same calls and controls: the
// context an agent reads for a pod (`GET /api/pods/:id/context`, with skill
// generation knobs), the pod's vector index (stats, rebuild, rebuild-all), and
// memory search with a line excerpt. The route wraps it in <ProtectedRoute
// requireAdmin> and the V2FeaturePage chrome, so this renders the page body.
// An operator tool, kept in English like the page it replaces.
import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import ReactMarkdown from 'react-markdown';
import { useAuth } from '../../context/AuthContext';

type Scope = 'shared' | 'agent' | 'all';

interface Asset {
  _id: string;
  title?: string;
  type?: string;
  createdAt?: string;
  relevanceScore?: number;
  tags?: string[];
  metadata?: { scope?: string };
}

interface Skill {
  _id?: string;
  id?: string;
  title?: string;
  content?: string;
  score?: number;
  tags?: string[];
  metadata?: { skillName?: string; score?: number; tags?: string[]; markdown?: string };
}

interface Summary {
  _id: string;
  title?: string;
  createdAt?: string;
  relevanceScore?: number;
  tags?: string[];
  content?: string;
}

interface PodContext {
  pod?: { name?: string; description?: string };
  task?: string | null;
  skillModeUsed?: string;
  skillWarnings?: string[];
  stats?: { summaries?: number; assets?: number; tags?: number; skills?: number };
  skills?: Skill[];
  tags?: Array<{ tag: string; count: number }>;
  summaries?: Summary[];
  assets?: Asset[];
}

interface SearchResult {
  assetId: string;
  title?: string;
  type?: string;
  score?: number;
  tags?: string[];
  snippet?: string;
}

interface Excerpt {
  assetId?: string;
  title?: string;
  type?: string;
  tags?: string[];
  text?: string;
  startLine?: number;
  endLine?: number;
}

const SUMMARY_TYPES = new Set(['summary', 'integration-summary']);

const TYPE_LABELS: Record<string, string> = {
  summary: 'Summary',
  'integration-summary': 'Integration Summary',
  memory: 'Memory',
  'daily-log': 'Daily Log',
  message: 'Message',
  thread: 'Thread',
  file: 'File',
  doc: 'Doc',
  link: 'Link',
  skill: 'Skill',
};

const MEMORY_TYPE_OPTIONS = [
  { value: 'summary', label: 'Summary Assets' },
  { value: 'integration-summary', label: 'Integration Assets' },
  { value: 'memory', label: 'Memory' },
  { value: 'daily-log', label: 'Daily Logs' },
  { value: 'skill', label: 'Skills' },
  { value: 'message', label: 'Messages' },
  { value: 'thread', label: 'Threads' },
  { value: 'file', label: 'Files' },
  { value: 'doc', label: 'Docs' },
  { value: 'link', label: 'Links' },
];

const SCOPE_OPTIONS: Array<{ value: Scope; label: string }> = [
  { value: 'shared', label: 'Shared (pod)' },
  { value: 'agent', label: 'Agent-only' },
  { value: 'all', label: 'All scopes' },
];

const formatDate = (value?: string): string => {
  if (!value) return 'Unknown time';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown time' : date.toLocaleString();
};

const errorText = (err: unknown, key: 'message' | 'error', fallback: string): string => {
  const data = (err as { response?: { data?: Record<string, string> } })?.response?.data;
  return data?.[key] || fallback;
};

const filterByScope = (assets: Asset[], scope: Scope): Asset[] => {
  if (scope === 'all') return assets;
  if (scope === 'agent') return assets.filter((a) => a?.metadata?.scope === 'agent');
  return assets.filter((a) => a?.metadata?.scope !== 'agent');
};

const groupByType = (assets: Asset[], grouped: boolean) => {
  if (!grouped) return [{ type: 'all', items: assets }];
  const groups = new Map<string, Asset[]>();
  assets.forEach((asset) => {
    const type = asset?.type || 'unknown';
    groups.set(type, [...(groups.get(type) || []), asset]);
  });
  return Array.from(groups.entries())
    .map(([type, items]) => ({ type, items }))
    .sort((a, b) => b.items.length - a.items.length || a.type.localeCompare(b.type));
};

const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode; wide?: boolean }> = ({
  label, hint, children, wide,
}) => (
  <label className={`v2-pod-context__field${wide ? ' v2-pod-context__field--wide' : ''}`}>
    <span className="v2-pod-context__label">{label}</span>
    {children}
    {hint && <span className="v2-pod-context__hint">{hint}</span>}
  </label>
);

const Check: React.FC<{ label: string; checked: boolean; onChange: (next: boolean) => void }> = ({
  label, checked, onChange,
}) => (
  <label className="v2-pod-context__check">
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    <span>{label}</span>
  </label>
);

const Tags: React.FC<{ tags?: string[] }> = ({ tags }) => (
  tags?.length ? (
    <div className="v2-pod-context__chips">
      {tags.map((tag) => <span key={tag} className="v2p-chip">{tag}</span>)}
    </div>
  ) : null
);

const Notice: React.FC<{ tone: 'error' | 'warning' | 'success'; children: React.ReactNode }> = ({ tone, children }) => (
  <div className={`v2-pod-context__notice v2-pod-context__notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
    {children}
  </div>
);

const AssetGroups: React.FC<{ groups: Array<{ type: string; items: Asset[] }>; empty: string }> = ({ groups, empty }) => {
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  if (!total) return <p className="v2-pod-context__muted">{empty}</p>;
  return (
    <>
      {groups.some((g) => g.type !== 'all') && (
        <div className="v2-pod-context__chips">
          {groups.map((g) => (
            <span key={g.type} className="v2p-chip">{`${TYPE_LABELS[g.type] || g.type} (${g.items.length})`}</span>
          ))}
        </div>
      )}
      {groups.map((group) => (
        <div key={group.type} className="v2-pod-context__group">
          {group.type !== 'all' && (
            <h4 className="v2-pod-context__group-title">{`${TYPE_LABELS[group.type] || group.type} · ${group.items.length}`}</h4>
          )}
          {group.items.map((asset) => (
            <div key={asset._id} className="v2-pod-context__item">
              <div className="v2-pod-context__item-title">{asset.title}</div>
              <div className="v2-pod-context__meta">
                {formatDate(asset.createdAt)}
                {typeof asset.relevanceScore === 'number' && ` · score ${asset.relevanceScore}`}
              </div>
              <div className="v2-pod-context__chips">
                {asset.type && <span className="v2p-chip">{asset.type}</span>}
                {asset.metadata?.scope && <span className="v2p-chip">{`scope: ${asset.metadata.scope}`}</span>}
                {(asset.tags || []).map((tag) => <span key={tag} className="v2p-chip">{tag}</span>)}
              </div>
            </div>
          ))}
        </div>
      ))}
    </>
  );
};

const V2PodContextDev: React.FC = () => {
  const { token } = useAuth();
  const [pods, setPods] = useState<Array<{ _id: string; name: string }>>([]);
  const [podId, setPodId] = useState('');
  const [loadingPods, setLoadingPods] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [task, setTask] = useState('');
  const [summaryLimit, setSummaryLimit] = useState('6');
  const [assetLimit, setAssetLimit] = useState('12');
  const [tagLimit, setTagLimit] = useState('16');
  const [skillLimit, setSkillLimit] = useState('6');
  const [skillMode, setSkillMode] = useState('llm');
  const [skillRefreshHours, setSkillRefreshHours] = useState('6');
  const [scope, setScope] = useState<Scope>('shared');
  const [showSummaryContent, setShowSummaryContent] = useState(false);
  const [showSummaryAssets, setShowSummaryAssets] = useState(false);
  const [groupAssets, setGroupAssets] = useState(true);
  const [context, setContext] = useState<PodContext | null>(null);
  const [loadingContext, setLoadingContext] = useState(false);

  const [indexStats, setIndexStats] = useState<{ stats?: Record<string, number | boolean> } | null>(null);
  const [indexBusy, setIndexBusy] = useState<'' | 'stats' | 'pod' | 'all'>('');
  const [indexError, setIndexError] = useState<string | null>(null);
  const [indexDone, setIndexDone] = useState<string | null>(null);

  const [memoryQuery, setMemoryQuery] = useState('');
  const [memoryLimit, setMemoryLimit] = useState('8');
  const [memoryTypes, setMemoryTypes] = useState<string[]>([]);
  const [includeSkills, setIncludeSkills] = useState(false);
  const [autoLoadExcerpt, setAutoLoadExcerpt] = useState(true);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [excerptAssetId, setExcerptAssetId] = useState('');
  const [excerptFrom, setExcerptFrom] = useState('1');
  const [excerptLines, setExcerptLines] = useState('12');
  const [excerpt, setExcerpt] = useState<Excerpt | null>(null);
  const [excerptLoading, setExcerptLoading] = useState(false);
  const [excerptError, setExcerptError] = useState<string | null>(null);

  const headers = useMemo(() => (token ? { Authorization: `Bearer ${token}` } : {}), [token]);

  useEffect(() => {
    if (!token) {
      setPods([]);
      setPodId('');
      setLoadingPods(false);
      return;
    }
    let live = true;
    setLoadingPods(true);
    axios.get('/api/pods', { headers })
      .then((res) => {
        if (!live) return;
        const list = res.data || [];
        setPods(list);
        setPodId((prev) => prev || list[0]?._id || '');
        setError(null);
      })
      .catch(() => { if (live) setError('Failed to load pods.'); })
      .finally(() => { if (live) setLoadingPods(false); });
    return () => { live = false; };
  }, [headers, token]);

  // Index, search and excerpt state belong to one pod: an excerpt request for
  // the old pod's asset id under the new pod's path would miss.
  useEffect(() => {
    setIndexStats(null);
    setIndexError(null);
    setIndexDone(null);
    setResults([]);
    setSearchError(null);
    setExcerptAssetId('');
    setExcerpt(null);
    setExcerptError(null);
  }, [podId]);

  const assets = context?.assets || [];
  const summaryAssets = filterByScope(assets.filter((a) => SUMMARY_TYPES.has(a.type || '')), scope);
  const otherAssets = filterByScope(assets.filter((a) => !SUMMARY_TYPES.has(a.type || '')), scope);

  const fetchContext = async () => {
    if (!podId || !token) return;
    setLoadingContext(true);
    try {
      const res = await axios.get(`/api/pods/${podId}/context`, {
        headers,
        params: {
          task: task || undefined,
          summaryLimit: summaryLimit || undefined,
          assetLimit: assetLimit || undefined,
          tagLimit: tagLimit || undefined,
          skillLimit: skillLimit || undefined,
          skillMode: skillMode || undefined,
          skillRefreshHours: skillRefreshHours || undefined,
        },
      });
      setContext(res.data);
      setError(null);
    } catch (err) {
      setError(errorText(err, 'message', 'Failed to fetch pod context.'));
    } finally {
      setLoadingContext(false);
    }
  };

  const fetchIndexStats = async () => {
    if (!podId || !token) return;
    setIndexBusy('stats');
    try {
      const res = await axios.get(`/api/v1/pods/${podId}/index/stats`, { headers });
      setIndexStats(res.data);
      setIndexError(null);
    } catch (err) {
      setIndexError(errorText(err, 'error', 'Failed to fetch index stats.'));
    } finally {
      setIndexBusy('');
    }
  };

  const rebuildIndex = async (reset: boolean) => {
    if (!podId || !token) return;
    setIndexBusy('pod');
    setIndexDone(null);
    try {
      const res = await axios.post(`/api/v1/pods/${podId}/index/rebuild`, { reset }, { headers });
      setIndexDone(`Rebuilt index: ${res.data?.indexed} indexed, ${res.data?.errors} errors.`);
      setIndexError(null);
      await fetchIndexStats();
    } catch (err) {
      setIndexError(errorText(err, 'error', 'Failed to rebuild index.'));
    } finally {
      setIndexBusy('');
    }
  };

  const rebuildAll = async () => {
    if (!token) return;
    setIndexBusy('all');
    setIndexDone(null);
    try {
      const res = await axios.post('/api/v1/index/rebuild-all', { reset: true }, { headers });
      setIndexDone(`Rebuilt ${res.data?.pods} pods: ${res.data?.indexed} indexed, ${res.data?.errors} errors.`);
      setIndexError(null);
      if (podId) await fetchIndexStats();
    } catch (err) {
      setIndexError(errorText(err, 'error', 'Failed to rebuild all indices.'));
    } finally {
      setIndexBusy('');
    }
  };

  const fetchExcerpt = async (assetId: string) => {
    if (!podId || !token || !assetId) return;
    setExcerptLoading(true);
    setExcerptAssetId(assetId);
    try {
      const res = await axios.get(`/api/pods/${podId}/context/assets/${assetId}`, {
        headers,
        params: { from: excerptFrom || undefined, lines: excerptLines || undefined },
      });
      setExcerpt(res.data);
      setExcerptError(null);
    } catch (err) {
      setExcerptError(errorText(err, 'message', 'Failed to fetch asset excerpt.'));
    } finally {
      setExcerptLoading(false);
    }
  };

  const searchMemory = async () => {
    if (!podId || !token || !memoryQuery.trim()) return;
    setSearching(true);
    try {
      const res = await axios.get(`/api/pods/${podId}/context/search`, {
        headers,
        params: {
          query: memoryQuery,
          limit: memoryLimit || undefined,
          includeSkills: includeSkills ? 'true' : undefined,
          types: memoryTypes.length ? memoryTypes.join(',') : undefined,
        },
      });
      setResults(res.data?.results || []);
      setSearchError(null);
    } catch (err) {
      setSearchError(errorText(err, 'message', 'Failed to search pod memory.'));
    } finally {
      setSearching(false);
    }
  };

  const selectResult = (assetId: string) => {
    setExcerptAssetId(assetId);
    if (autoLoadExcerpt) fetchExcerpt(assetId);
  };

  const toggleType = (value: string) => setMemoryTypes((prev) => (
    prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]
  ));

  if (!token) {
    return <Notice tone="warning">You need to be signed in as an admin to use this tool.</Notice>;
  }

  return (
    <div className="v2-pod-context">
      <section className="v2-pod-context__section">
        <div>
          <h2 className="v2-pod-context__title">Context</h2>
          <p className="v2-pod-context__sub">What an agent reads for this pod, including LLM-generated markdown skills.</p>
        </div>
        <div className="v2-pod-context__grid">
          <Field label="Pod" hint={pods.length ? undefined : 'No pods available.'} wide>
            <select
              className="v2-pod-context__input"
              value={podId}
              onChange={(e) => setPodId(e.target.value)}
              disabled={loadingPods || !pods.length}
            >
              {pods.map((pod) => <option key={pod._id} value={pod._id}>{pod.name}</option>)}
            </select>
          </Field>
          <Field label="Task (optional)" wide>
            <input
              className="v2-pod-context__input"
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder="e.g. incident runbook checklist"
            />
          </Field>
          <Field label="Summary limit">
            <input className="v2-pod-context__input" type="number" min={1} max={20} value={summaryLimit} onChange={(e) => setSummaryLimit(e.target.value)} />
          </Field>
          <Field label="Asset limit">
            <input className="v2-pod-context__input" type="number" min={1} max={40} value={assetLimit} onChange={(e) => setAssetLimit(e.target.value)} />
          </Field>
          <Field label="Tag limit">
            <input className="v2-pod-context__input" type="number" min={1} max={40} value={tagLimit} onChange={(e) => setTagLimit(e.target.value)} />
          </Field>
          <Field label="Skill limit">
            <input className="v2-pod-context__input" type="number" min={1} max={12} value={skillLimit} onChange={(e) => setSkillLimit(e.target.value)} />
          </Field>
          <Field label="Skill mode" hint="LLM mode writes markdown skill docs and stores them as pod assets." wide>
            <select className="v2-pod-context__input" value={skillMode} onChange={(e) => setSkillMode(e.target.value)}>
              <option value="llm">LLM</option>
              <option value="heuristic">Heuristic (fallback)</option>
              <option value="none">Disabled</option>
            </select>
          </Field>
          <Field label="Skill refresh hours" hint="Skills refresh when stale or when a task is given.">
            <input className="v2-pod-context__input" type="number" min={1} max={72} value={skillRefreshHours} onChange={(e) => setSkillRefreshHours(e.target.value)} />
          </Field>
          <Field label="Asset scope">
            <select className="v2-pod-context__input" value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
              {SCOPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
        </div>
        <div className="v2-pod-context__row">
          <Check label="Show summary content (markdown)" checked={showSummaryContent} onChange={setShowSummaryContent} />
          <Check label="Show summary assets" checked={showSummaryAssets} onChange={setShowSummaryAssets} />
          <Check label="Group assets by type" checked={groupAssets} onChange={setGroupAssets} />
        </div>
        <div className="v2-pod-context__row">
          <button type="button" className="v2p-b v2p-b-p" onClick={fetchContext} disabled={!podId || loadingPods || loadingContext}>
            {loadingContext ? 'Fetching…' : 'Fetch context'}
          </button>
          {loadingPods && <span className="v2-pod-context__muted">Loading pods…</span>}
        </div>
        {error && <Notice tone="error">{error}</Notice>}
      </section>

      {context?.pod && (
        <>
          <section className="v2-pod-context__section v2-pod-context__card">
            <h3 className="v2-pod-context__card-title">{context.pod.name}</h3>
            <p className="v2-pod-context__muted">{context.pod.description || 'No description provided.'}</p>
            <div className="v2-pod-context__chips">
              <span className="v2p-chip">{`Summaries: ${context.stats?.summaries ?? 0}`}</span>
              <span className="v2p-chip">{`Assets: ${context.stats?.assets ?? 0}`}</span>
              <span className="v2p-chip">{`Assets (non-summary): ${otherAssets.length}`}</span>
              <span className="v2p-chip">{`Summary assets: ${summaryAssets.length}`}</span>
              <span className="v2p-chip">{`Tags: ${context.stats?.tags ?? 0}`}</span>
              <span className="v2p-chip">{`Skills: ${context.stats?.skills ?? 0}`}</span>
              {context.skillModeUsed && <span className="v2p-chip">{`Skill mode: ${context.skillModeUsed}`}</span>}
            </div>
            {context.task && <p className="v2-pod-context__muted">{`Task: ${context.task}`}</p>}
            {!!context.skillWarnings?.length && <Notice tone="warning">{context.skillWarnings.join(' ')}</Notice>}
          </section>

          <section className="v2-pod-context__section v2-pod-context__card">
            <h3 className="v2-pod-context__card-title">Skills (LLM markdown)</h3>
            {(context.skills || []).map((skill) => {
              const key = skill._id || skill.id || skill.title;
              const score = skill.metadata?.score ?? skill.score;
              const markdown = skill.content || skill.metadata?.markdown;
              return (
                <div key={key} className="v2-pod-context__item">
                  <div className="v2-pod-context__item-title">
                    {skill.title || skill.metadata?.skillName || 'Skill'}
                    {typeof score === 'number' && <span className="v2-pod-context__meta">{` score ${score}`}</span>}
                  </div>
                  <Tags tags={skill.tags || skill.metadata?.tags} />
                  {markdown
                    ? <div className="v2-pod-context__markdown"><ReactMarkdown>{markdown}</ReactMarkdown></div>
                    : <p className="v2-pod-context__muted">No markdown content for this skill.</p>}
                </div>
              );
            })}
            {!(context.skills || []).length && (
              <p className="v2-pod-context__muted">No skills yet. Set skill mode to LLM and fetch context.</p>
            )}
          </section>

          <section className="v2-pod-context__section v2-pod-context__card">
            <h3 className="v2-pod-context__card-title">Top tags</h3>
            <div className="v2-pod-context__chips">
              {(context.tags || []).map((entry) => (
                <span key={entry.tag} className="v2p-chip">{`${entry.tag} (${entry.count})`}</span>
              ))}
            </div>
            {!(context.tags || []).length && <p className="v2-pod-context__muted">No tags yet.</p>}
          </section>

          <div className="v2-pod-context__split">
            <section className="v2-pod-context__section v2-pod-context__card">
              <h3 className="v2-pod-context__card-title">Chat summaries</h3>
              <p className="v2-pod-context__muted">The Summary collection, separate from pod asset memory.</p>
              {(context.summaries || []).map((summary) => (
                <div key={summary._id} className="v2-pod-context__item">
                  <div className="v2-pod-context__item-title">{summary.title}</div>
                  <div className="v2-pod-context__meta">
                    {formatDate(summary.createdAt)}
                    {typeof summary.relevanceScore === 'number' && ` · score ${summary.relevanceScore}`}
                  </div>
                  <Tags tags={summary.tags} />
                  {showSummaryContent && summary.content && (
                    <div className="v2-pod-context__markdown"><ReactMarkdown>{summary.content}</ReactMarkdown></div>
                  )}
                </div>
              ))}
              {!(context.summaries || []).length && <p className="v2-pod-context__muted">No summaries for this pod.</p>}
            </section>

            <section className="v2-pod-context__section v2-pod-context__card">
              <h3 className="v2-pod-context__card-title">Assets (non-summary)</h3>
              <p className="v2-pod-context__muted">Pod assets other than summaries, so nothing repeats the chat summaries.</p>
              <AssetGroups groups={groupByType(otherAssets, groupAssets)} empty="No assets for this pod." />
            </section>
          </div>

          {showSummaryAssets && (
            <section className="v2-pod-context__section v2-pod-context__card">
              <h3 className="v2-pod-context__card-title">Summary assets</h3>
              <p className="v2-pod-context__muted">Summary and integration-summary pod assets, often derived from chat summaries.</p>
              <AssetGroups groups={groupByType(summaryAssets, groupAssets)} empty="No summary assets for this pod." />
            </section>
          )}
        </>
      )}

      {podId && (
        <section className="v2-pod-context__section v2-pod-context__card">
          <h3 className="v2-pod-context__card-title">Vector index</h3>
          <div className="v2-pod-context__row">
            <button type="button" className="v2p-b v2p-b-s" onClick={fetchIndexStats} disabled={!!indexBusy}>
              {indexBusy === 'stats' ? 'Loading…' : 'Fetch stats'}
            </button>
            <button type="button" className="v2p-b v2p-b-s" onClick={() => rebuildIndex(false)} disabled={!!indexBusy}>
              Rebuild index
            </button>
            <button type="button" className="v2p-b v2p-b-s" onClick={() => rebuildIndex(true)} disabled={!!indexBusy}>
              Reset and rebuild
            </button>
            <button type="button" className="v2p-b v2p-b-g" onClick={rebuildAll} disabled={!!indexBusy}>
              Reset and rebuild all pods
            </button>
            {indexBusy === 'pod' && <span className="v2-pod-context__muted">Rebuilding…</span>}
            {indexBusy === 'all' && <span className="v2-pod-context__muted">Rebuilding all pods…</span>}
          </div>
          {indexError && <Notice tone="error">{indexError}</Notice>}
          {indexDone && <Notice tone="success">{indexDone}</Notice>}
          {indexStats?.stats && (
            <div className="v2-pod-context__chips">
              <span className="v2p-chip">{`Available: ${indexStats.stats.available}`}</span>
              <span className="v2p-chip">{`Chunks: ${indexStats.stats.chunks ?? 0}`}</span>
              <span className="v2p-chip">{`Assets: ${indexStats.stats.assets ?? 0}`}</span>
              <span className="v2p-chip">{`Embeddings: ${indexStats.stats.embeddings ?? 0}`}</span>
            </div>
          )}
        </section>
      )}

      {podId && (
        <section className="v2-pod-context__section v2-pod-context__card">
          <h3 className="v2-pod-context__card-title">Memory search</h3>
          <div className="v2-pod-context__grid">
            <Field label="Query" wide>
              <input
                className="v2-pod-context__input"
                value={memoryQuery}
                onChange={(e) => setMemoryQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !searching && !e.nativeEvent.isComposing) searchMemory();
                }}
                placeholder="Search pod memory…"
              />
            </Field>
            <Field label="Result limit">
              <input className="v2-pod-context__input" type="number" min={1} max={40} value={memoryLimit} onChange={(e) => setMemoryLimit(e.target.value)} />
            </Field>
          </div>
          <div className="v2-pod-context__chips" role="group" aria-label="Filter types">
            {MEMORY_TYPE_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                className={`v2p-chip v2p-chip--btn${memoryTypes.includes(o.value) ? ' on' : ''}`}
                aria-pressed={memoryTypes.includes(o.value)}
                onClick={() => toggleType(o.value)}
              >
                {o.label}
              </button>
            ))}
          </div>
          <div className="v2-pod-context__row">
            <Check label="Include skills" checked={includeSkills} onChange={setIncludeSkills} />
            <Check label="Load the excerpt on select" checked={autoLoadExcerpt} onChange={setAutoLoadExcerpt} />
          </div>
          <div className="v2-pod-context__row">
            <button type="button" className="v2p-b v2p-b-p" onClick={searchMemory} disabled={!memoryQuery.trim() || searching}>
              {searching ? 'Searching…' : 'Search memory'}
            </button>
            {task && (
              <button type="button" className="v2p-b v2p-b-g" onClick={() => setMemoryQuery(task)}>Use task as query</button>
            )}
            <button
              type="button"
              className="v2p-b v2p-b-g"
              onClick={() => { setMemoryQuery(''); setMemoryTypes([]); setResults([]); setSearchError(null); }}
            >
              Clear
            </button>
          </div>
          {searchError && <Notice tone="error">{searchError}</Notice>}
          {results.map((result) => (
            <div key={result.assetId} className="v2-pod-context__item v2-pod-context__item--boxed">
              <div className="v2-pod-context__item-title">
                {result.title}
                {result.type && <span className="v2p-chip">{result.type}</span>}
                {typeof result.score === 'number' && <span className="v2-pod-context__meta">{`score ${result.score.toFixed(2)}`}</span>}
              </div>
              <Tags tags={result.tags} />
              {result.snippet && <p className="v2-pod-context__muted">{result.snippet}</p>}
              <div>
                <button type="button" className="v2p-b v2p-b-s v2p-b-sm" onClick={() => selectResult(result.assetId)}>
                  {autoLoadExcerpt ? 'Open excerpt' : 'Select for excerpt'}
                </button>
              </div>
            </div>
          ))}
          {memoryQuery.trim() && !results.length && !searching && (
            <p className="v2-pod-context__muted">No matches yet. Try a wider query or fewer types.</p>
          )}

          <div className="v2-pod-context__excerpt">
            <h4 className="v2-pod-context__group-title">Asset excerpt</h4>
            <div className="v2-pod-context__row">
              <Field label="From line">
                <input className="v2-pod-context__input" type="number" min={1} max={10000} value={excerptFrom} onChange={(e) => setExcerptFrom(e.target.value)} />
              </Field>
              <Field label="Lines">
                <input className="v2-pod-context__input" type="number" min={1} max={100} value={excerptLines} onChange={(e) => setExcerptLines(e.target.value)} />
              </Field>
              <span className="v2-pod-context__muted">
                {excerptAssetId ? `Selected asset: ${excerptAssetId}` : 'Select a search result to load an excerpt.'}
              </span>
              {excerptAssetId && !excerptLoading && (
                <button type="button" className="v2p-b v2p-b-g v2p-b-sm" onClick={() => fetchExcerpt(excerptAssetId)}>Load excerpt</button>
              )}
            </div>
            {excerptLoading && <span className="v2-pod-context__muted">Loading excerpt…</span>}
            {excerptError && <Notice tone="error">{excerptError}</Notice>}
            {excerpt && !excerptLoading && (
              <>
                <div className="v2-pod-context__item-title">
                  {excerpt.title || 'Excerpt'}
                  {excerpt.type && <span className="v2p-chip">{excerpt.type}</span>}
                  {excerpt.startLine && <span className="v2-pod-context__meta">{`lines ${excerpt.startLine}-${excerpt.endLine}`}</span>}
                </div>
                <Tags tags={excerpt.tags} />
                <pre className="v2-pod-context__pre">{excerpt.text || 'No content available.'}</pre>
              </>
            )}
          </div>
        </section>
      )}
    </div>
  );
};

export default V2PodContextDev;
