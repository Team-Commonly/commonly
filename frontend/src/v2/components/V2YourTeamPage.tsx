import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import V2Avatar from './V2Avatar';

interface PodSummary {
  _id: string;
  name?: string;
  title?: string;
}

interface AgentInstallationSummary {
  name: string;
  instanceId: string;
  displayName?: string;
  iconUrl?: string;
  status?: string;
  installedAt?: string;
  lastHeartbeatAt?: string | null;
  runtime?: { runtimeType?: string; provider?: string } | null;
  category?: string | null;
  podId?: string;
  podName?: string;
}

const RUNTIME_LABEL: Record<string, string> = {
  internal: 'Native',
  moltbot: 'OpenClaw',
  webhook: 'Webhook',
  cli: 'CLI wrapper',
  managed: 'Cloud sandbox',
};

const formatRuntime = (a: AgentInstallationSummary): string => {
  const t = a.runtime?.runtimeType;
  if (!t) return 'Native';
  return RUNTIME_LABEL[t] || t;
};

const formatRelative = (iso?: string | null): string => {
  if (!iso) return 'No recent activity';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return 'No recent activity';
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'Just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
};

const dedupeAgents = (agents: AgentInstallationSummary[]): AgentInstallationSummary[] => {
  const seen = new Map<string, AgentInstallationSummary>();
  for (const a of agents) {
    const key = `${a.name}:${a.instanceId || 'default'}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, a);
      continue;
    }
    const prev = existing.lastHeartbeatAt ? new Date(existing.lastHeartbeatAt).getTime() : 0;
    const next = a.lastHeartbeatAt ? new Date(a.lastHeartbeatAt).getTime() : 0;
    if (next > prev) seen.set(key, a);
  }
  return Array.from(seen.values());
};

const V2YourTeamPage: React.FC = () => {
  const navigate = useNavigate();
  const [agents, setAgents] = useState<AgentInstallationSummary[]>([]);
  const [pods, setPods] = useState<PodSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Active category filter — 'all' means no filter. Tabs build dynamically
  // from the union of categories present on loaded agents so a sparse team
  // doesn't render empty filters.
  const [filter, setFilter] = useState<string>('all');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const token = localStorage.getItem('token');
        const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
        const podsRes = await axios.get<PodSummary[] | { pods: PodSummary[] }>('/api/pods', { headers });
        const userPods: PodSummary[] = Array.isArray(podsRes.data)
          ? podsRes.data
          : podsRes.data?.pods || [];
        if (cancelled) return;
        setPods(userPods);

        const perPod = await Promise.all(userPods.map(async (p) => {
          try {
            const r = await axios.get<{ agents: AgentInstallationSummary[] }>(
              `/api/registry/pods/${p._id}/agents`,
              { headers },
            );
            return (r.data?.agents || []).map((a) => ({
              ...a,
              podId: p._id,
              podName: p.name || p.title || 'Untitled project',
            }));
          } catch {
            return [];
          }
        }));
        if (cancelled) return;
        const flat = perPod.flat();
        setAgents(dedupeAgents(flat));
      } catch (e: unknown) {
        if (cancelled) return;
        const msg = (e as { message?: string })?.message || 'Could not load your team.';
        setError(msg);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, []);

  const sortedAgents = useMemo(() => {
    return [...agents].sort((a, b) => {
      const ta = a.lastHeartbeatAt ? new Date(a.lastHeartbeatAt).getTime() : 0;
      const tb = b.lastHeartbeatAt ? new Date(b.lastHeartbeatAt).getTime() : 0;
      return tb - ta;
    });
  }, [agents]);

  // Available categories — derived from loaded agents. Order: deterministic
  // alpha so the tab bar doesn't reflow as activity timestamps change.
  const categories = useMemo(() => {
    const set = new Set<string>();
    sortedAgents.forEach((a) => { if (a.category) set.add(a.category); });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [sortedAgents]);

  const filteredAgents = useMemo(() => (
    filter === 'all'
      ? sortedAgents
      : sortedAgents.filter((a) => (a.category || 'Uncategorized') === filter)
  ), [sortedAgents, filter]);

  return (
    <div className="v2-team">
      <header className="v2-team__header">
        <div>
          <h1 className="v2-team__title">Your Team</h1>
          <p className="v2-team__subtitle">
            {loading
              ? 'Loading…'
              : sortedAgents.length === 0
                ? 'No agents yet — hire your first one to get started.'
                : `${sortedAgents.length} agent${sortedAgents.length === 1 ? '' : 's'} working across ${pods.length} project${pods.length === 1 ? '' : 's'}`}
          </p>
        </div>
        <button
          type="button"
          className="v2-team__hire-cta"
          onClick={() => navigate('/v2/agents/browse')}
        >
          + Hire an agent
        </button>
      </header>

      {error && (
        <div className="v2-team__error">{error}</div>
      )}

      {!loading && sortedAgents.length === 0 && !error && (
        <div className="v2-team__empty">
          <div className="v2-team__empty-title">Build your AI team</div>
          <div className="v2-team__empty-text">
            Agents you hire join your projects, share your project memory, and ship work back to you.
          </div>
          <button
            type="button"
            className="v2-team__hire-cta"
            onClick={() => navigate('/v2/agents/browse')}
          >
            + Hire your first agent
          </button>
        </div>
      )}

      {categories.length > 1 && (
        <div className="v2-team__tabs" role="tablist" aria-label="Filter by role">
          <button
            type="button"
            role="tab"
            className={`v2-team__tab${filter === 'all' ? ' v2-team__tab--active' : ''}`}
            aria-selected={filter === 'all'}
            onClick={() => setFilter('all')}
          >
            All ({sortedAgents.length})
          </button>
          {categories.map((cat) => {
            const count = sortedAgents.filter((a) => a.category === cat).length;
            return (
              <button
                key={cat}
                type="button"
                role="tab"
                className={`v2-team__tab${filter === cat ? ' v2-team__tab--active' : ''}`}
                aria-selected={filter === cat}
                onClick={() => setFilter(cat)}
              >
                {cat} ({count})
              </button>
            );
          })}
        </div>
      )}

      <div className="v2-team__grid">
        {filteredAgents.map((a) => {
          const display = a.displayName || a.name;
          const podLabel = a.podName || 'Untitled project';
          const runtimeLabel = formatRuntime(a);
          const lastSeen = formatRelative(a.lastHeartbeatAt);
          const onCardClick = () => {
            if (a.podId) navigate(`/v2/pods/${a.podId}`);
          };
          return (
            <article
              key={`${a.name}:${a.instanceId}`}
              className="v2-team-card"
              onClick={onCardClick}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') onCardClick(); }}
            >
              <V2Avatar
                name={display}
                src={a.iconUrl && a.iconUrl.trim() ? a.iconUrl.trim() : undefined}
                size="lg"
                online={a.status === 'active'}
              />
              <div className="v2-team-card__body">
                <div className="v2-team-card__name-row">
                  <span className="v2-team-card__name">{display}</span>
                  {a.category && (
                    <span className="v2-role-chip" title={`Role: ${a.category}`}>{a.category}</span>
                  )}
                  <span className="v2-team-card__runtime">{runtimeLabel}</span>
                </div>
                <div className="v2-team-card__pod">in <em>{podLabel}</em></div>
                <div className="v2-team-card__activity">
                  <span className="v2-team-card__dot" data-active={a.status === 'active'} />
                  {lastSeen}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
};

export default V2YourTeamPage;
