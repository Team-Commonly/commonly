// Tools — the second list on the Connectors page (tools plan §6, option A,
// Sam 67407). Same container grammar as the channels: dot, 20px glyph,
// display name, two-line middle, mono when, one action. It renders only what
// the server counts: a row per RoomGrant the person can see, the aside from
// the projected grant read, the trail from ToolCall rows the broker wrote.
//
// SEAM: the not-yet-granted row, the Add form and Change access need a tool
// catalogue the server does not expose yet (no tool Installable in
// /api/installables, no route for the broker's tool list or its brokerId —
// raised with Wren, Connectors v2 67719). Until it lands, `catalog` is empty
// and those controls do not render; nothing here pretends to grant.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useV2Api } from '../hooks/useV2Api';
import { V2Pod } from '../hooks/useV2Pods';
import { PlatformGlyph } from '../icons/platforms';

export type GrantWriteMode = 'read' | 'write' | 'write-with-confirm';

export interface ToolGrant {
  grantId: string;
  installationId: string;
  target: { kind: 'pod' | 'seat'; id: string };
  tools: string[];
  writeMode: GrantWriteMode;
  budget: { calls?: number; windowMs?: number } | null;
  effectiveAudience: string[];
  expiresAt: string;
  revokedAt: string | null;
  parentGrantId: string | null;
  rootGrantId: string | null;
  createdAt: string;
  grantedBy: string | null;
}

export interface ToolCallLine {
  callId: string;
  agentUserId: string;
  tool: string;
  outcome: 'ok' | 'refused' | 'pending_approval' | 'failed';
  reason: string | null;
  approvalId: string | null;
  argsDigest: string;
  at: string | null;
  durationMs: number | null;
}

export interface ToolTrail {
  grantId: string;
  calls: ToolCallLine[];
  counts: { total: number; ok: number; refused: number; pending_approval: number; failed: number };
}

/** A tool the catalogue returns (SEAM: none on main yet). */
export interface ToolCatalogEntry {
  tool: string;
  label: string;
  description: string;
  tools: string[];
}

interface PodSeat { userId: string | null; displayName?: string; name: string; internal?: boolean }

interface Props {
  pods: V2Pod[];
  catalog?: ToolCatalogEntry[];
}

const USED_RECENTLY_MS = 10 * 60 * 1000;
const MAX_PODS = 20;

export const relativeTime = (date?: string | null): string => {
  if (!date) return '—';
  const ms = Date.now() - new Date(date).getTime();
  if (!Number.isFinite(ms)) return '—';
  const abs = Math.abs(ms);
  const suffix = ms >= 0 ? 'ago' : 'from now';
  const minutes = Math.round(abs / 60_000);
  if (minutes < 1) return ms >= 0 ? 'just now' : 'in a moment';
  if (minutes < 60) return `${minutes}m ${suffix}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ${suffix}`;
  const days = Math.round(hours / 24);
  return `${days}d ${suffix}`;
};

const isExpired = (grant: ToolGrant, now = Date.now()): boolean => new Date(grant.expiresAt).getTime() <= now;
const isDead = (grant: ToolGrant): boolean => Boolean(grant.revokedAt) || isExpired(grant);

// Grants on main are GitHub App connections (piece 2); the label follows the
// connection, the catalogue's description follows when the catalogue exists.
const TOOL_LABEL = 'GitHub';

const V2ConnectorTools: React.FC<Props> = ({ pods, catalog = [] }) => {
  const { t } = useTranslation();
  const api = useV2Api();
  const [grants, setGrants] = useState<ToolGrant[] | null>(null);
  const [seats, setSeats] = useState<Record<string, PodSeat[]>>({});
  const [lastUse, setLastUse] = useState<Record<string, string | null>>({});
  const [trail, setTrail] = useState<ToolTrail | null>(null);
  const [trailError, setTrailError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [segment, setSegment] = useState<'all' | 'granted' | 'not-yet'>('all');

  const podIds = useMemo(() => pods.slice(0, MAX_PODS).map((pod) => String(pod._id)), [pods]);

  const load = useCallback(async () => {
    if (podIds.length === 0) { setGrants([]); return; }
    const results = await Promise.all(podIds.map(async (podId) => {
      const [grantsRes, seatsRes] = await Promise.all([
        api.get<{ grants: ToolGrant[] }>(`/api/pods/${podId}/grants`).catch(() => null),
        api.get<{ agents?: PodSeat[] }>(`/api/registry/pods/${podId}/agents`).catch(() => null),
      ]);
      return { podId, grants: grantsRes?.grants ?? [], seats: seatsRes?.agents ?? [] };
    }));
    const seen = new Set<string>();
    const merged: ToolGrant[] = [];
    const seatMap: Record<string, PodSeat[]> = {};
    for (const result of results) {
      seatMap[result.podId] = result.seats;
      for (const grant of result.grants) {
        if (seen.has(grant.grantId)) continue; // a seat grant can surface from two pods
        seen.add(grant.grantId);
        merged.push(grant);
      }
    }
    merged.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    setGrants(merged);
    setSeats(seatMap);
    // "used in the last 10 min" reads the newest trail row's `at` (§6).
    const uses = await Promise.all(merged.filter((grant) => !isDead(grant)).map(async (grant) => {
      const res = await api.get<ToolTrail>(`/api/grants/${grant.grantId}/calls`, { params: { limit: 1 } }).catch(() => null);
      return [grant.grantId, res?.calls?.[0]?.at ?? null] as const;
    }));
    setLastUse(Object.fromEntries(uses));
  }, [api, podIds]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!selectedId) { setTrail(null); return undefined; }
    let cancelled = false;
    setTrail(null);
    setTrailError(false);
    api.get<ToolTrail>(`/api/grants/${selectedId}/calls`)
      .then((res) => { if (!cancelled) setTrail(res); })
      .catch(() => { if (!cancelled) setTrailError(true); });
    return () => { cancelled = true; };
  }, [api, selectedId]);

  const podName = (podId: string): string => pods.find((pod) => String(pod._id) === podId)?.name || t('tools.aPod', { defaultValue: 'a pod' });
  const memberName = (userId: string | null): string | null => {
    if (!userId) return null;
    for (const pod of pods) {
      for (const member of pod.members || []) {
        if (typeof member === 'object' && member && String(member._id) === userId && member.username) return member.username;
      }
    }
    return null;
  };
  const seatLabel = (podId: string | null, userId: string): string => {
    const pool = podId ? (seats[podId] || []) : Object.values(seats).flat();
    const seat = pool.find((row) => row.userId === userId) || Object.values(seats).flat().find((row) => row.userId === userId);
    return seat ? (seat.displayName || seat.name) : t('tools.aSeat', { defaultValue: 'an agent' });
  };
  const grantPodId = (grant: ToolGrant): string | null => {
    if (grant.target.kind === 'pod') return grant.target.id;
    const entry = Object.entries(seats).find(([, rows]) => rows.some((row) => row.userId === grant.target.id));
    return entry ? entry[0] : null;
  };
  const audienceLabels = (grant: ToolGrant): string => {
    const podId = grantPodId(grant);
    const labels = grant.effectiveAudience.map((id) => seatLabel(podId, id));
    if (labels.length === 0) return t('tools.nobody', { defaultValue: 'no agent' });
    return labels.join(', ');
  };
  const asksFirst = (grant: ToolGrant): string => {
    if (grant.writeMode === 'read') return t('tools.asksNothing', { defaultValue: 'nothing asks first' });
    if (grant.writeMode === 'write-with-confirm') return t('tools.asksEveryWrite', { defaultValue: 'every write asks first' });
    // Under `write` the floor is the tool's own irreversible flag (piece 2b);
    // the list of those tools comes with the catalogue (SEAM).
    return t('tools.asksIrreversible', { defaultValue: 'irreversible writes ask first' });
  };

  const usedRecently = (grant: ToolGrant): boolean => {
    const at = lastUse[grant.grantId];
    return Boolean(at) && Date.now() - new Date(at as string).getTime() < USED_RECENTLY_MS;
  };

  const rows = useMemo(() => (grants || []).filter((grant) => {
    if (segment === 'not-yet') return false;
    if (!query.trim()) return true;
    const q = query.trim().toLowerCase();
    return TOOL_LABEL.toLowerCase().includes(q) || grant.tools.some((tool) => tool.toLowerCase().includes(q));
  }), [grants, query, segment]);
  const notYet = useMemo(() => (segment === 'granted' ? [] : catalog.filter((entry) => (
    !query.trim() || entry.label.toLowerCase().includes(query.trim().toLowerCase())
  ))), [catalog, query, segment]);
  const grantedCount = (grants || []).filter((grant) => !isDead(grant)).length;

  const selected = selectedId ? (grants || []).find((grant) => grant.grantId === selectedId) || null : null;

  const revoke = async (grant: ToolGrant) => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/grants/${grant.grantId}/revoke`);
      setConfirmRevoke(null);
      await load();
    } catch {
      setError(t('tools.revokeError', { defaultValue: 'Could not revoke the grant.' }));
    } finally {
      setBusy(false);
    }
  };

  const renderRow = (grant: ToolGrant) => {
    const dead = isDead(grant);
    const podId = grantPodId(grant);
    const granter = memberName(grant.grantedBy);
    const isSelected = selectedId === grant.grantId;
    const when = t('tools.grantedWhen', { defaultValue: 'granted {{rel}}', rel: relativeTime(grant.createdAt) });
    const line2 = dead
      ? (grant.revokedAt
        ? t('tools.revokedLine', { defaultValue: 'revoked {{rel}}', rel: relativeTime(grant.revokedAt) })
        : t('tools.expiredLine', { defaultValue: 'expired {{rel}}', rel: relativeTime(grant.expiresAt) }))
      : `${audienceLabels(grant)} ${t('tools.mayUse', { defaultValue: 'may use it' })} · ${asksFirst(grant)}`;
    return (
      <article key={grant.grantId} className={`v2-connector-row${isSelected ? ' v2-connector-row--selected' : ''}`}>
        <button
          type="button"
          className="v2-connector-row__selection"
          aria-pressed={isSelected}
          aria-label={t('tools.viewGrant', { defaultValue: 'View {{tool}} in {{pod}}', tool: TOOL_LABEL, pod: podId ? podName(podId) : seatLabel(null, grant.target.id) })}
          onClick={() => { setSelectedId(isSelected ? null : grant.grantId); setConfirmRevoke(null); }}
        >
          <span className="v2-connector-row__name">
            <span className={`v2-connector-row__dot ${dead ? 'v2-connector-row__dot--empty' : `v2-connector-row__dot--live${usedRecently(grant) ? ' v2-connector-row__dot--pulse' : ''}`}`} aria-hidden="true" />
            <span className="v2-connector-row__glyph" aria-hidden="true"><PlatformGlyph type="github" /></span>
            <span>{TOOL_LABEL}</span>
          </span>
          <span className="v2-connector-row__details">
            <strong>
              {grant.target.kind === 'pod'
                ? <>{t('tools.grantedTo', { defaultValue: 'granted to' })} <b>{podName(grant.target.id)}</b></>
                : <>{t('tools.grantedToSeat', { defaultValue: 'granted to' })} <b>{seatLabel(podId, grant.target.id)}</b></>}
              {granter && <> {t('tools.by', { defaultValue: 'by' })} <b>{granter}</b></>}
            </strong>
            <span className="v2-connector-row__detail">{line2}</span>
          </span>
          <span className="v2-connector-row__when">{when}</span>
        </button>
        <button
          type="button"
          className="v2-connector-row__action v2-connector-row__action--secondary"
          onClick={() => { setSelectedId(grant.grantId); setConfirmRevoke(null); }}
        >
          {t('tools.manage', { defaultValue: 'Manage' })}
        </button>
      </article>
    );
  };

  const renderNotYet = (entry: ToolCatalogEntry) => (
    <article key={entry.tool} className="v2-connector-row v2-connector-row--not-yet">
      <span className="v2-connector-row__name">
        <span className="v2-connector-row__dot v2-connector-row__dot--not-yet" aria-hidden="true" />
        <span className="v2-connector-row__glyph" aria-hidden="true"><PlatformGlyph type={entry.tool} /></span>
        <span>{entry.label}</span>
      </span>
      <span className="v2-connector-row__details">
        <strong>{entry.description}</strong>
        <span className="v2-connector-row__detail">{t('tools.readOrWrite', { defaultValue: 'read, or read and write' })}</span>
      </span>
      <span className="v2-connector-row__when">{t('tools.notGranted', { defaultValue: 'not granted' })}</span>
      {/* SEAM: Add opens the grant form once the catalogue carries the tool list and the broker id. */}
    </article>
  );

  const renderAside = (grant: ToolGrant) => {
    const dead = isDead(grant);
    const podId = grantPodId(grant);
    const granter = memberName(grant.grantedBy);
    const byMode: Record<GrantWriteMode, string> = {
      read: t('tools.modeRead', { defaultValue: 'read' }),
      'write-with-confirm': t('tools.modeWriteConfirm', { defaultValue: 'read and write, ask first' }),
      write: t('tools.modeWrite', { defaultValue: 'read and write' }),
    };
    const counts = trail?.counts;
    return (
      <aside className="v2-connectors__aside v2-tools__aside" aria-label={t('tools.grantDetails', { defaultValue: 'Grant details' })}>
        <section className="v2-connector-aside__card">
          <p className="v2-connector-aside__eyebrow">{t('tools.grant', { defaultValue: 'grant' })}</p>
          <h2>{TOOL_LABEL} · {grant.target.kind === 'pod' ? podName(grant.target.id) : seatLabel(podId, grant.target.id)}</h2>
          <p>
            {granter
              ? t('tools.grantedByOn', { defaultValue: 'Granted by {{member}} {{rel}}.', member: granter, rel: relativeTime(grant.createdAt) })
              : t('tools.grantedOn', { defaultValue: 'Granted {{rel}}.', rel: relativeTime(grant.createdAt) })}
            {' '}
            {grant.revokedAt
              ? t('tools.endedRevoked', { defaultValue: 'Revoked {{rel}}.', rel: relativeTime(grant.revokedAt) })
              : (isExpired(grant)
                ? t('tools.endedExpired', { defaultValue: 'Expired {{rel}}.', rel: relativeTime(grant.expiresAt) })
                : t('tools.ends', { defaultValue: 'Ends {{rel}}.', rel: relativeTime(grant.expiresAt) }))}
          </p>
          <dl className="v2-tools__facts">
            <dt>{t('tools.agentsAllowed', { defaultValue: 'agents allowed' })}</dt>
            <dd>{audienceLabels(grant)}</dd>
            <dt>{byMode[grant.writeMode]}</dt>
            <dd>{grant.tools.length ? grant.tools.map((tool) => <code key={tool}>{tool}</code>) : t('tools.noTools', { defaultValue: 'no tools on the allow-list' })}</dd>
            <dt>{t('tools.asksFirst', { defaultValue: 'asks a person first' })}</dt>
            <dd>{asksFirst(grant)}</dd>
            {grant.budget?.calls !== undefined && (
              <>
                <dt>{t('tools.budget', { defaultValue: 'budget' })}</dt>
                <dd>{grant.budget.windowMs
                  ? t('tools.budgetWindow', { defaultValue: '{{calls}} calls per {{window}}', calls: grant.budget.calls, window: relativeTime(new Date(Date.now() - grant.budget.windowMs).toISOString()).replace(' ago', '') })
                  : t('tools.budgetTotal', { defaultValue: '{{calls}} calls', calls: grant.budget.calls })}</dd>
              </>
            )}
          </dl>
          {/* SEAM: Change access opens the Add form pre-filled from effectiveAudience once the catalogue lands. */}
          {!dead && (confirmRevoke === grant.grantId ? (
            <div className="v2-connector-aside__actions">
              <button type="button" className="v2-connector-aside__primary" disabled={busy} onClick={() => { void revoke(grant); }}>
                {t('tools.revokeConfirm', { defaultValue: 'Yes, revoke it' })}
              </button>
              <button type="button" className="v2-connector-aside__secondary" disabled={busy} onClick={() => setConfirmRevoke(null)}>
                {t('tools.keep', { defaultValue: 'Keep it' })}
              </button>
            </div>
          ) : (
            <div className="v2-connector-aside__actions">
              <button type="button" className="v2-connector-aside__secondary" onClick={() => setConfirmRevoke(grant.grantId)}>
                {t('tools.revoke', { defaultValue: 'Revoke' })}
              </button>
            </div>
          ))}
          {error && <p className="v2-connector-aside__note" role="alert">{error}</p>}
        </section>
        <section className="v2-connector-aside__card">
          <p className="v2-connector-aside__eyebrow">{t('tools.trail', { defaultValue: 'trail' })}</p>
          <div className="v2-tools__counts" aria-label={t('tools.counts', { defaultValue: 'Call counts' })}>
            <div className="v2-tools__count"><strong>{counts ? counts.total : '—'}</strong><span>{t('tools.calls', { defaultValue: 'calls' })}</span></div>
            <div className="v2-tools__count"><strong>{counts ? counts.refused : '—'}</strong><span>{t('tools.refused', { defaultValue: 'refused' })}</span></div>
            <div className="v2-tools__count"><strong>{counts ? counts.pending_approval : '—'}</strong><span>{t('tools.awaiting', { defaultValue: 'awaiting a person' })}</span></div>
          </div>
          {trailError && <p className="v2-connector-aside__note">{t('tools.trailError', { defaultValue: 'Could not read the trail.' })}</p>}
          {trail && trail.calls.length === 0 && <p className="v2-connector-aside__note">{t('tools.trailEmpty', { defaultValue: 'No calls yet.' })}</p>}
          {trail && trail.calls.length > 0 && (
            <ol className="v2-tools__trail">
              {trail.calls.map((line) => (
                <li key={line.callId} className="v2-tools__trail-line">
                  <span>{seatLabel(podId, line.agentUserId)} · {line.tool} · {line.outcome}</span>
                  <span className="v2-tools__trail-when">{relativeTime(line.at)}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </aside>
    );
  };

  if (grants === null) {
    return <div className="v2-connectors__loading">{t('tools.loading', { defaultValue: 'Loading tools…' })}</div>;
  }
  if (grants.length === 0 && catalog.length === 0) return null; // nothing the server has to show

  return (
    <div className="v2-connectors__content v2-tools">
      <section className="v2-connectors__main" aria-label={t('tools.title', { defaultValue: 'Tools' })}>
        <div className="v2-tools__head">
          <h2 className="v2-tools__title">{t('tools.title', { defaultValue: 'Tools' })}</h2>
          <span className="v2-tools__count-line">
            {t('tools.grantedCount', { defaultValue: '{{count}} granted', count: grantedCount })}
            {catalog.length > 0 && ` · ${t('tools.moreCount', { defaultValue: '{{count}} more', count: catalog.length })}`}
          </span>
          <input
            type="search"
            className="v2-tools__search"
            value={query}
            placeholder={t('tools.search', { defaultValue: 'Search tools' })}
            aria-label={t('tools.search', { defaultValue: 'Search tools' })}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="v2-connector-aside__mode v2-tools__segment" role="group" aria-label={t('tools.filter', { defaultValue: 'Show' })}>
            {(['all', 'granted', 'not-yet'] as const).map((key) => (
              <button
                key={key}
                type="button"
                className={segment === key ? 'v2-connector-aside__mode-opt v2-connector-aside__mode-opt--on' : 'v2-connector-aside__mode-opt'}
                aria-pressed={segment === key}
                onClick={() => setSegment(key)}
              >
                {key === 'all' ? t('tools.segAll', { defaultValue: 'All' }) : key === 'granted' ? t('tools.segGranted', { defaultValue: 'Granted' }) : t('tools.segNotYet', { defaultValue: 'Not yet' })}
              </button>
            ))}
          </div>
        </div>
        <div className="v2-connectors__rows">
          {rows.map(renderRow)}
          {notYet.map(renderNotYet)}
          {rows.length === 0 && notYet.length === 0 && (
            <p className="v2-tools__empty">{t('tools.nothingMatches', { defaultValue: 'Nothing matches.' })}</p>
          )}
        </div>
      </section>
      {selected ? renderAside(selected) : null}
    </div>
  );
};

export default V2ConnectorTools;
