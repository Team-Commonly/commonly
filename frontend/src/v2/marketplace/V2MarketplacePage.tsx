/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import './V2MarketplacePage.css';

// Fresh v2-native marketplace browse page. Routed at /v2/marketplace. The
// legacy AppsMarketplacePage stays on the v1 /apps mount; this one owns the
// v2 shell. Reuses the shipped /api/marketplace/* + /api/registry/* endpoints
// and the install→detail wiring (card body → detail page; Install → inline
// install into the selected pod, matching the legacy marketplace behavior).

interface App {
  id: string;
  installableId?: string;
  name?: string;
  displayName?: string;
  description?: string;
  installationId?: string;
  instanceId?: string;
  installBackend?: 'apps' | 'registry';
  [key: string]: unknown;
}

interface Pod {
  _id: string;
  name: string;
}

const CATEGORIES = [
  { id: 'all', label: 'All categories' },
  { id: 'productivity', label: 'Productivity' },
  { id: 'development', label: 'Development' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'support', label: 'Support' },
  { id: 'communication', label: 'Communication' },
  { id: 'other', label: 'Other' },
];

const KINDS = [
  { id: 'all', label: 'All kinds' },
  { id: 'agent', label: 'Agents' },
  { id: 'app', label: 'Apps' },
  { id: 'skill', label: 'Skills' },
  { id: 'bundle', label: 'Bundles' },
];

const authHeaders = (): Record<string, string> => ({
  'x-auth-token': localStorage.getItem('token') || '',
});

const toMarketplaceApp = (item: any): App => {
  const installableId = String(item?.installableId ?? item?._id ?? item?.id ?? '');
  const handle = installableId.replace(/^@/, '');
  const stats = item?.stats && typeof item.stats === 'object' ? item.stats : {};
  const marketplace = item?.marketplace && typeof item.marketplace === 'object' ? item.marketplace : {};
  const requires = Array.isArray(item?.requires) ? item.requires : [];
  return {
    ...item,
    id: installableId,
    installableId,
    name: handle || String(item?.name || ''),
    displayName: String(item?.name || installableId || 'Unknown'),
    description: String(item?.description || ''),
    kind: String(item?.kind || 'app'),
    category: String(marketplace.category || 'other'),
    verified: Boolean(marketplace.verified),
    rating: Number(marketplace.rating || 0),
    installs: Number(stats.totalInstalls || marketplace.installCount || 0),
    logo: marketplace.logoUrl || marketplace.logo || null,
    scopes: requires,
    installBackend: 'registry',
  };
};

const toInstalledRegistryApp = (agent: any): App => {
  const installableId = String(agent?.name || '');
  const profile = agent?.profile && typeof agent.profile === 'object' ? agent.profile : {};
  return {
    ...agent,
    id: installableId,
    installableId,
    name: installableId.replace(/^@/, ''),
    displayName: String(agent?.displayName || installableId || 'Unknown'),
    description: String(profile.purpose || ''),
    kind: 'agent',
    category: String(agent?.category || 'other'),
    logo: agent?.iconUrl || null,
    instanceId: String(agent?.instanceId || 'default'),
    installBackend: 'registry',
  };
};

const toInstalledLegacyApp = (app: any): App => ({
  ...app,
  id: String(app?.id || ''),
  installBackend: 'apps',
});

const initial = (s?: string): string => (s || '?').trim().charAt(0).toUpperCase() || '?';

const V2MarketplacePage: React.FC = () => {
  const navigate = useNavigate();
  const [apps, setApps] = useState<App[]>([]);
  const [official, setOfficial] = useState<any[]>([]);
  const [integrations, setIntegrations] = useState<any[]>([]);
  const [installed, setInstalled] = useState<App[]>([]);
  const [pods, setPods] = useState<Pod[]>([]);
  const [selectedPodId, setSelectedPodId] = useState('');
  const [tab, setTab] = useState<'discover' | 'installed'>('discover');
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('all');
  const [category, setCategory] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  // Set when an install is refused because the account lacks the cloud-agents
  // entitlement. Rendered as an actionable banner pointing at the BYO flow,
  // which works for any account — never the generic "try again" error.
  const [gate, setGate] = useState<string | null>(null);
  const [busyId, setBusyId] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const res = await axios.get('/api/pods', { headers: authHeaders() });
        const list = (res.data as Pod[]) || [];
        setPods(list);
        setSelectedPodId((prev) => prev || list[0]?._id || '');
      } catch {
        /* pods are optional for browsing */
      }
    })();
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (search) params.append('q', search);
        if (category !== 'all') params.append('category', category);
        if (kind !== 'all') params.append('kind', kind);
        const res = await axios.get(`/api/marketplace/browse?${params.toString()}`);
        if (cancelled) return;
        setApps((((res.data as any)?.items) || []).map(toMarketplaceApp));
      } catch {
        if (cancelled) return;
        setError('Failed to load the marketplace.');
        setApps([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [search, category, kind]);

  useEffect(() => {
    (async () => {
      try {
        const res = await axios.get('/api/marketplace/official');
        setOfficial((((res.data as any)?.entries) || []));
      } catch {
        /* official listings are best-effort */
      }
      if (!localStorage.getItem('token')) return;
      try {
        const res = await axios.get('/api/integrations/catalog', { headers: authHeaders() });
        setIntegrations((((res.data as any)?.entries) || []));
      } catch {
        /* integration stats are best-effort */
      }
    })();
  }, []);

  const fetchInstalled = useCallback(async () => {
    if (!selectedPodId) return;
    try {
      const [legacy, registry] = await Promise.allSettled([
        axios.get(`/api/apps/pods/${selectedPodId}/apps`, { headers: authHeaders() }),
        axios.get(`/api/registry/pods/${selectedPodId}/agents`, { headers: authHeaders() }),
      ]);
      const legacyApps = legacy.status === 'fulfilled'
        ? ((((legacy.value.data as any).apps) || []).map(toInstalledLegacyApp)) : [];
      const registryApps = registry.status === 'fulfilled'
        ? ((((registry.value.data as any).agents) || []).map(toInstalledRegistryApp)) : [];
      setInstalled([...legacyApps, ...registryApps]);
    } catch {
      /* leave installed list as-is on transient error */
    }
  }, [selectedPodId]);

  useEffect(() => { fetchInstalled(); }, [fetchInstalled]);

  const isInstalled = (id: string): boolean => installed.some((a) => a.id === id);

  const integrationsById = useMemo(() => integrations.reduce((acc: Record<string, any>, e: any) => {
    acc[e.id] = e; return acc;
  }, {}), [integrations]);

  const officialListings = useMemo(() => official.map((e: any) => ({
    ...e,
    capabilities: integrationsById[e.id]?.catalog?.capabilities || e.capabilities || [],
    activeCount: integrationsById[e.id]?.stats?.activeIntegrations,
  })), [official, integrationsById]);

  const officialIntegrations = officialListings.filter((e: any) => e.type !== 'mcp-app');
  const mcpListings = officialListings.filter((e: any) => e.type === 'mcp-app');

  const openDetail = (app: App) => {
    const id = String(app.installableId || app.id || '');
    if (id) navigate(`/v2/marketplace/${encodeURIComponent(id)}`);
  };

  const install = async (app: App, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!selectedPodId) { setStatus('Pick a pod above to install into.'); return; }
    setBusyId(app.id);
    setStatus(null);
    setGate(null);
    try {
      await axios.post('/api/registry/install', {
        agentName: String(app.installableId || app.id || ''),
        podId: selectedPodId,
        version: typeof app.version === 'string' ? app.version : undefined,
        displayName: app.displayName || undefined,
        scopes: Array.isArray(app.scopes) ? app.scopes : [],
      }, { headers: authHeaders() });
      setStatus(`Installed ${app.displayName || app.name} into ${pods.find((p) => p._id === selectedPodId)?.name || 'pod'}.`);
      fetchInstalled();
    } catch (err: any) {
      const data = err?.response?.data;
      if (data?.code === 'cloud_agents_not_entitled') {
        setGate(data.message || 'Hosted agents require an upgrade or admin — connect your own agent instead.');
      } else {
        setStatus(data?.error || 'Could not install — try again.');
      }
    } finally {
      setBusyId('');
    }
  };

  const remove = async (app: App, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!selectedPodId) return;
    setBusyId(app.id);
    try {
      if (app.installBackend === 'registry') {
        const id = encodeURIComponent(String(app.installableId || app.id || ''));
        const params = new URLSearchParams();
        if (app.instanceId && app.instanceId !== 'default') params.append('instanceId', app.instanceId);
        const suffix = params.toString() ? `?${params.toString()}` : '';
        await axios.delete(`/api/registry/agents/${id}/pods/${selectedPodId}${suffix}`, { headers: authHeaders() });
      } else {
        await axios.delete(`/api/apps/pods/${selectedPodId}/apps/${app.installationId}`, { headers: authHeaders() });
      }
      setStatus(`Removed ${app.displayName || app.name}.`);
      fetchInstalled();
    } catch {
      setStatus('Could not remove — try again.');
    } finally {
      setBusyId('');
    }
  };

  const connect = (entry: any) => {
    setStatus(`Open a pod to connect ${entry.name}.`);
    navigate('/v2');
  };

  const renderListingCard = (app: App) => {
    const installedNow = isInstalled(app.id);
    const busy = busyId === app.id;
    return (
      <article
        key={app.id}
        className="v2-mkt-card"
        role="button"
        tabIndex={0}
        onClick={() => openDetail(app)}
        onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openDetail(app); } }}
      >
        <div className="v2-mkt-card__head">
          {app.logo ? (
            <img className="v2-mkt-card__logo" src={String(app.logo)} alt="" aria-hidden="true" />
          ) : (
            <div className="v2-mkt-card__logo v2-mkt-card__logo--placeholder">{initial(app.displayName)}</div>
          )}
          <div className="v2-mkt-card__id">
            <div className="v2-mkt-card__name-row">
              <span className="v2-mkt-card__name">{app.displayName}</span>
              {app.verified ? <span className="v2-mkt-card__badge" title="Verified by Commonly">Verified</span> : null}
            </div>
            <span className="v2-mkt-card__handle">@{app.name}</span>
          </div>
        </div>
        <p className="v2-mkt-card__desc">{app.description || 'No description provided.'}</p>
        <div className="v2-mkt-card__meta">
          <span className="v2-mkt-card__chip">{String(app.kind || 'app')}</span>
          <span className="v2-mkt-card__stat">{Number(app.installs || 0)} installs</span>
        </div>
        <div className="v2-mkt-card__actions">
          {installedNow ? (
            <button
              type="button"
              className="v2-mkt-card__btn v2-mkt-card__btn--ghost"
              disabled={busy}
              onClick={(ev) => remove(app, ev)}
            >
              {busy ? 'Removing…' : 'Remove'}
            </button>
          ) : (
            <button
              type="button"
              className="v2-mkt-card__btn"
              disabled={busy}
              onClick={(ev) => install(app, ev)}
            >
              {busy ? 'Installing…' : 'Install'}
            </button>
          )}
        </div>
      </article>
    );
  };

  const renderOfficialCard = (entry: any) => {
    const isMcp = entry.type === 'mcp-app';
    const caps: string[] = Array.isArray(entry.capabilities) ? entry.capabilities : [];
    return (
      <article key={entry.id} className="v2-mkt-card v2-mkt-card--static">
        <div className="v2-mkt-card__head">
          {entry.logoUrl ? (
            <img className="v2-mkt-card__logo" src={entry.logoUrl} alt="" aria-hidden="true" />
          ) : (
            <div className="v2-mkt-card__logo v2-mkt-card__logo--placeholder">{initial(entry.name)}</div>
          )}
          <div className="v2-mkt-card__id">
            <span className="v2-mkt-card__name">{entry.name}</span>
            <span className="v2-mkt-card__handle">{isMcp ? 'MCP app' : entry.type || 'integration'}{entry.category ? ` · ${entry.category}` : ''}</span>
          </div>
        </div>
        <p className="v2-mkt-card__desc">{entry.description || ''}</p>
        {caps.length > 0 && (
          <div className="v2-mkt-card__meta">
            {caps.slice(0, 4).map((c) => <span key={c} className="v2-mkt-card__chip">{c}</span>)}
          </div>
        )}
        <div className="v2-mkt-card__actions">
          <button
            type="button"
            className="v2-mkt-card__btn"
            disabled={isMcp}
            onClick={() => (isMcp ? undefined : connect(entry))}
          >
            {isMcp ? 'MCP host required' : 'Connect in pod'}
          </button>
          {entry.docsUrl && (
            <a className="v2-mkt-card__btn v2-mkt-card__btn--ghost" href={entry.docsUrl} target="_blank" rel="noreferrer">Docs</a>
          )}
        </div>
      </article>
    );
  };

  return (
    <div className="v2-mkt">
      <header className="v2-mkt__header">
        <h1 className="v2-mkt__title">Marketplace</h1>
        <p className="v2-mkt__subtitle">Browse and install agents, apps, and integrations.</p>
      </header>

      <div className="v2-mkt__filterbar">
        <input
          className="v2-mkt__search"
          type="search"
          placeholder="Search agents, apps, integrations…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className="v2-mkt__control" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
          {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
        </select>
        <select className="v2-mkt__control" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
          {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        {pods.length > 0 && (
          <select className="v2-mkt__control" value={selectedPodId} onChange={(e) => setSelectedPodId(e.target.value)} aria-label="Install to pod">
            {pods.map((p) => <option key={p._id} value={p._id}>{p.name}</option>)}
          </select>
        )}
      </div>

      <div className="v2-mkt__tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'discover'} className={`v2-mkt__tab${tab === 'discover' ? ' v2-mkt__tab--active' : ''}`} onClick={() => setTab('discover')}>
          Discover
        </button>
        <button type="button" role="tab" aria-selected={tab === 'installed'} className={`v2-mkt__tab${tab === 'installed' ? ' v2-mkt__tab--active' : ''}`} onClick={() => setTab('installed')}>
          Installed{installed.length ? ` (${installed.length})` : ''}
        </button>
      </div>

      {status && <div className="v2-mkt__status" role="status">{status}</div>}
      {gate && (
        <div className="v2-mkt__gate" role="alert">
          <span className="v2-mkt__gate-text">{gate}</span>
          <button
            type="button"
            className="v2-mkt__gate-btn"
            onClick={() => navigate('/v2/agents/byo')}
          >
            Connect your own agent
          </button>
        </div>
      )}
      {error && <div className="v2-mkt__error">{error}</div>}

      {tab === 'discover' ? (
        <>
          <section className="v2-mkt__section">
            <h2 className="v2-mkt__section-title">{search || kind !== 'all' || category !== 'all' ? 'Results' : 'All listings'}</h2>
            {loading ? (
              <div className="v2-mkt__grid">
                {[0, 1, 2, 3].map((i) => <div key={i} className="v2-mkt-card v2-mkt-card--skeleton" />)}
              </div>
            ) : apps.length === 0 ? (
              <div className="v2-mkt__empty">
                <div className="v2-mkt__empty-title">No listings yet</div>
                <div className="v2-mkt__empty-text">Nothing matches your filters. Try a broader search, or publish the first one.</div>
              </div>
            ) : (
              <div className="v2-mkt__grid">{apps.map(renderListingCard)}</div>
            )}
          </section>

          {officialIntegrations.length > 0 && (
            <section className="v2-mkt__section">
              <h2 className="v2-mkt__section-title">Official integrations</h2>
              <p className="v2-mkt__section-sub">Curated by Commonly — connect from a pod.</p>
              <div className="v2-mkt__grid">{officialIntegrations.map(renderOfficialCard)}</div>
            </section>
          )}

          {mcpListings.length > 0 && (
            <section className="v2-mkt__section">
              <h2 className="v2-mkt__section-title">MCP apps (preview)</h2>
              <p className="v2-mkt__section-sub">Interactive UI rendered inside MCP-compatible hosts.</p>
              <div className="v2-mkt__grid">{mcpListings.map(renderOfficialCard)}</div>
            </section>
          )}
        </>
      ) : (
        <section className="v2-mkt__section">
          {!selectedPodId ? (
            <div className="v2-mkt__empty"><div className="v2-mkt__empty-text">Pick a pod to see what&apos;s installed.</div></div>
          ) : installed.length === 0 ? (
            <div className="v2-mkt__empty">
              <div className="v2-mkt__empty-title">Nothing installed here yet</div>
              <div className="v2-mkt__empty-text">Browse Discover and install your first one.</div>
            </div>
          ) : (
            <div className="v2-mkt__grid">{installed.map(renderListingCard)}</div>
          )}
        </section>
      )}
    </div>
  );
};

export default V2MarketplacePage;
