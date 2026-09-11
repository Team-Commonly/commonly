// Tools — the second list on the Connectors page (tools plan §6, option A,
// Sam 67407). Same container grammar as the channels: dot, 20px glyph,
// display name, two-line middle, mono when, one action. It renders only what
// the server counts: a row per RoomGrant the person can see, a not-yet row per
// tool Installable the catalogue returns (#1670), the aside from the projected
// grant read, the trail from ToolCall rows the broker wrote. The Add form posts
// the mint exactly as the server takes it — never a brokerId (Vera 67728).
//
// Direction A (Sam 2026-09-11): categories are glyphs — a trail outcome and a
// grant's mode carry a mark with the word in `title`; the deciding act (Add,
// Grant, Manage on a row with one act) keeps its word.

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

export type ToolOutcome = 'ok' | 'refused' | 'pending_approval' | 'failed';

export interface ToolCallLine {
  callId: string;
  agentUserId: string;
  tool: string;
  outcome: ToolOutcome;
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

/** A tool Installable as GET /api/installables lists it (list: 'tools', #1670). */
export interface ToolCatalogEntry {
  installableId: string;
  list?: 'channels' | 'tools';
  label: string;
  description: string;
  available: boolean;
  unavailableReason?: string;
  broker?: { id: string };
  tools: Array<{ name: string; description?: string; requiredWriteMode: GrantWriteMode; irreversible: boolean }>;
  connections: Array<{ connectionId: string; owner: string; repo: string }>;
}

interface PodSeat { userId: string | null; displayName?: string; name: string; internal?: boolean }

interface Props {
  pods: V2Pod[];
}

interface DraftGrant {
  installableId: string;
  podId: string;
  connectionId: string;
  writeMode: GrantWriteMode;
  audience: string[];
  expiryDays: 7 | 30 | 90;
  /** Change access: the grant this one replaces (revoked after the mint). */
  replaces: string | null;
}

const USED_RECENTLY_MS = 10 * 60 * 1000;
const MAX_PODS = 20;
const MODE_RANK: Record<GrantWriteMode, number> = { read: 0, 'write-with-confirm': 1, write: 2 };

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

const G: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{children}</svg>
);
/** Outcome marks: a category, so a glyph; the word stays in the log line and the title. */
const OutcomeGlyph: React.FC<{ outcome: ToolOutcome }> = ({ outcome }) => {
  if (outcome === 'ok') return <G><path d="M20 6 9 17l-5-5" /></G>;
  if (outcome === 'refused') return <G><path d="M18 6 6 18M6 6l12 12" /></G>;
  if (outcome === 'pending_approval') return <G><path d="M12 3 4 6v6c0 5 3.4 8.4 8 9 4.6-.6 8-4 8-9V6z" /><path d="M12 8v5M12 16h.01" /></G>;
  return <G><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></G>;
};
/** Mode marks: eye for read, pen for write, shield for write that asks first. */
const ModeGlyph: React.FC<{ mode: GrantWriteMode }> = ({ mode }) => {
  if (mode === 'read') return <G><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></G>;
  if (mode === 'write') return <G><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></G>;
  return <G><path d="M12 3 4 6v6c0 5 3.4 8.4 8 9 4.6-.6 8-4 8-9V6z" /><path d="m9 12 2 2 4-4" /></G>;
};

const V2ConnectorTools: React.FC<Props> = ({ pods }) => {
  const { t } = useTranslation();
  const api = useV2Api();
  const [grants, setGrants] = useState<ToolGrant[] | null>(null);
  const [catalog, setCatalog] = useState<ToolCatalogEntry[]>([]);
  const [seats, setSeats] = useState<Record<string, PodSeat[]>>({});
  const [lastUse, setLastUse] = useState<Record<string, string | null>>({});
  const [trail, setTrail] = useState<ToolTrail | null>(null);
  const [trailError, setTrailError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftGrant | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [segment, setSegment] = useState<'all' | 'granted' | 'not-yet'>('all');

  const podIds = useMemo(() => pods.slice(0, MAX_PODS).map((pod) => String(pod._id)), [pods]);

  const load = useCallback(async () => {
    const catalogRes = await api.get<{ installables?: ToolCatalogEntry[] }>('/api/installables').catch(() => null);
    setCatalog((catalogRes?.installables || []).filter((entry) => entry.list === 'tools'));
    if (podIds.length === 0) { setGrants([]); return; }
    const results = await Promise.all(podIds.map(async (podId) => {
      const [grantsRes, seatsRes] = await Promise.all([
        api.get<{ grants: ToolGrant[] }>(`/api/pods/${podId}/grants`).catch(() => null),
        api.get<{ agents?: PodSeat[] }>(`/api/registry/pods/${podId}/agents`).catch(() => null),
      ]);
      return { podId, grants: grantsRes?.grants ?? [], seats: (seatsRes?.agents ?? []).filter((seat) => !seat.internal) };
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

  // Grants on main are GitHub App connections; the catalogue entry carries the label and what it does.
  const entryFor = (grant?: ToolGrant | null): ToolCatalogEntry | null => catalog.find((entry) => entry.installableId === 'github') || (grant ? null : null);
  const toolLabel = (grant?: ToolGrant | null): string => entryFor(grant)?.label || 'GitHub';

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
  const irreversibleTools = (entry: ToolCatalogEntry | null, tools: string[]): string[] => (entry?.tools || [])
    .filter((tool) => tool.irreversible && tools.includes(tool.name)).map((tool) => tool.name);
  const asksFirst = (grant: ToolGrant): string => {
    if (grant.writeMode === 'read') return t('tools.asksNothing', { defaultValue: 'nothing asks first' });
    if (grant.writeMode === 'write-with-confirm') return t('tools.asksEveryWrite', { defaultValue: 'every write asks first' });
    // Under `write` the floor is the tool's own irreversible flag (piece 2b): the list is the catalogue's.
    const list = irreversibleTools(entryFor(grant), grant.tools);
    return list.length
      ? t('tools.asksList', { defaultValue: '{{tools}} ask first', tools: list.join(', ') })
      : t('tools.asksNothing', { defaultValue: 'nothing asks first' });
  };
  const modeLabel = (mode: GrantWriteMode): string => ({
    read: t('tools.modeRead', { defaultValue: 'read' }),
    'write-with-confirm': t('tools.modeWriteConfirm', { defaultValue: 'read and write, ask first' }),
    write: t('tools.modeWrite', { defaultValue: 'read and write' }),
  })[mode];

  const usedRecently = (grant: ToolGrant): boolean => {
    const at = lastUse[grant.grantId];
    return Boolean(at) && Date.now() - new Date(at as string).getTime() < USED_RECENTLY_MS;
  };

  const q = query.trim().toLowerCase();
  const rows = useMemo(() => (grants || []).filter((grant) => {
    if (segment === 'not-yet') return false;
    if (!q) return true;
    return toolLabel(grant).toLowerCase().includes(q) || grant.tools.some((tool) => tool.toLowerCase().includes(q));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [grants, q, segment, catalog]);
  // A tool is "not yet" while no live grant on it exists anywhere the person can see.
  const notYet = useMemo(() => (segment === 'granted' ? [] : catalog.filter((entry) => (
    !(grants || []).some((grant) => !isDead(grant))
    && (!q || entry.label.toLowerCase().includes(q) || entry.tools.some((tool) => tool.name.toLowerCase().includes(q)))
  ))), [catalog, grants, q, segment]);
  const grantedCount = (grants || []).filter((grant) => !isDead(grant)).length;
  const moreCount = catalog.length - (grantedCount > 0 ? 1 : 0);

  const selected = selectedId ? (grants || []).find((grant) => grant.grantId === selectedId) || null : null;

  const openDraft = (entry: ToolCatalogEntry, from?: ToolGrant) => {
    const podId = from ? (grantPodId(from) || podIds[0] || '') : (podIds[0] || '');
    setDraft({
      installableId: entry.installableId,
      podId,
      connectionId: entry.connections[0]?.connectionId || '',
      writeMode: from?.writeMode || 'read',
      audience: from ? from.effectiveAudience : (seats[podId] || []).map((seat) => seat.userId).filter((id): id is string => Boolean(id)),
      expiryDays: 7,
      replaces: from && !isDead(from) ? from.grantId : null,
    });
    setSelectedId(null);
    setConfirmRevoke(null);
    setError(null);
  };
  const draftEntry = draft ? catalog.find((entry) => entry.installableId === draft.installableId) || null : null;
  const draftTools = (entry: ToolCatalogEntry | null, mode: GrantWriteMode): string[] => (entry?.tools || [])
    .filter((tool) => MODE_RANK[tool.requiredWriteMode] <= MODE_RANK[mode]).map((tool) => tool.name);

  const submitDraft = async () => {
    if (!draft || !draftEntry) return;
    setBusy(true);
    setError(null);
    try {
      const expiresAt = new Date(Date.now() + draft.expiryDays * 86_400_000).toISOString();
      // The mint's body, as routes/grants.ts takes it: the server names the broker (Vera 67728)
      // and takes the installation from the Connection (#1677, Vera 67821) — neither is the caller's.
      await api.post('/api/grants', {
        connectionId: draft.connectionId,
        target: { kind: 'pod', id: draft.podId },
        tools: draftTools(draftEntry, draft.writeMode),
        writeMode: draft.writeMode,
        audience: draft.audience,
        expiresAt,
      });
      // Change access: a change is a new grant and a revoke of the old one, because `tools` is never widened in place.
      if (draft.replaces) await api.post(`/api/grants/${draft.replaces}/revoke`);
      setDraft(null);
      await load();
    } catch (err) {
      const code = (err as { response?: { data?: { error?: string; message?: string } } })?.response?.data;
      setError(code?.message || code?.error || t('tools.grantError', { defaultValue: 'Could not grant it.' }));
    } finally {
      setBusy(false);
    }
  };

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
    const entry = entryFor(grant);
    const label = toolLabel(grant);
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
          aria-label={t('tools.viewGrant', { defaultValue: 'View {{tool}} in {{pod}}', tool: label, pod: podId ? podName(podId) : seatLabel(null, grant.target.id) })}
          onClick={() => { setSelectedId(isSelected ? null : grant.grantId); setDraft(null); setConfirmRevoke(null); }}
        >
          <span className="v2-connector-row__name">
            <span className={`v2-connector-row__dot ${dead ? 'v2-connector-row__dot--empty' : `v2-connector-row__dot--live${usedRecently(grant) ? ' v2-connector-row__dot--pulse' : ''}`}`} aria-hidden="true" />
            <span className="v2-connector-row__glyph" aria-hidden="true"><PlatformGlyph type={entry?.installableId || 'github'} /></span>
            <span>{label}</span>
          </span>
          <span className="v2-connector-row__details">
            <strong>
              {/* Direction A: what the tool does is the not-yet row's and the aside's sentence, not the granted row's. */}
              {t('tools.grantedTo', { defaultValue: 'granted to' })} <b>{grant.target.kind === 'pod' ? podName(grant.target.id) : seatLabel(podId, grant.target.id)}</b>
              {granter && <> {t('tools.by', { defaultValue: 'by' })} <b>{granter}</b></>}
            </strong>
            <span className="v2-connector-row__detail">
              {!dead && <span className="v2-tools__mode" title={modeLabel(grant.writeMode)} role="img" aria-label={modeLabel(grant.writeMode)}><ModeGlyph mode={grant.writeMode} /></span>}
              {line2}
            </span>
          </span>
          <span className="v2-connector-row__when">{when}</span>
        </button>
        {dead && entry ? (
          <button type="button" className="v2-connector-row__action" onClick={() => openDraft(entry, grant)}>
            {t('tools.grantAgain', { defaultValue: 'Grant again' })}
          </button>
        ) : (
          <button type="button" className="v2-connector-row__action v2-connector-row__action--secondary" onClick={() => { setSelectedId(grant.grantId); setDraft(null); setConfirmRevoke(null); }}>
            {t('tools.manage', { defaultValue: 'Manage' })}
          </button>
        )}
      </article>
    );
  };

  const renderNotYet = (entry: ToolCatalogEntry) => {
    const canAdd = entry.available && entry.connections.length > 0 && podIds.length > 0;
    return (
      <article key={entry.installableId} className="v2-connector-row v2-connector-row--not-yet">
        <span className="v2-connector-row__name">
          <span className="v2-connector-row__dot v2-connector-row__dot--not-yet" aria-hidden="true" />
          <span className="v2-connector-row__glyph" aria-hidden="true"><PlatformGlyph type={entry.installableId} /></span>
          <span>{entry.label}</span>
        </span>
        <span className="v2-connector-row__details">
          <strong>{entry.description}</strong>
          <span className="v2-connector-row__detail">
            {!entry.available
              ? t('tools.notEnabled', { defaultValue: 'not enabled on this instance · ask your operator' })
              : entry.connections.length === 0
                ? t('tools.noConnection', { defaultValue: 'install the GitHub App first · an admin does this once' })
                : t('tools.readOrWrite', { defaultValue: 'read, or read and write' })}
          </span>
        </span>
        <span className="v2-connector-row__when">{t('tools.notGranted', { defaultValue: 'not granted' })}</span>
        {canAdd && (
          <button type="button" className="v2-connector-row__action" onClick={() => openDraft(entry)}>
            {t('tools.add', { defaultValue: 'Add' })}
          </button>
        )}
      </article>
    );
  };

  const renderDraft = () => {
    if (!draft || !draftEntry) return null;
    const podSeats = seats[draft.podId] || [];
    const tools = draftTools(draftEntry, draft.writeMode);
    const irreversible = irreversibleTools(draftEntry, tools);
    const asks = draft.writeMode === 'read'
      ? t('tools.asksNothing', { defaultValue: 'nothing asks first' })
      : draft.writeMode === 'write-with-confirm'
        ? t('tools.asksEveryWrite', { defaultValue: 'every write asks first' })
        : (irreversible.length ? t('tools.asksList', { defaultValue: '{{tools}} ask first', tools: irreversible.join(', ') }) : t('tools.asksNothing', { defaultValue: 'nothing asks first' }));
    return (
      <aside className="v2-connectors__aside v2-tools__aside" aria-label={draft.replaces ? t('tools.changeAccess', { defaultValue: 'Change access' }) : t('tools.addTool', { defaultValue: 'Add {{tool}}', tool: draftEntry.label })}>
        <section className="v2-connector-aside__card">
          <p className="v2-connector-aside__eyebrow">{draft.replaces ? t('tools.changeAccess', { defaultValue: 'Change access' }) : t('tools.grant', { defaultValue: 'grant' })}</p>
          <h2>{draftEntry.label} · {podName(draft.podId)}</h2>
          <p>{draftEntry.description}</p>
          <div className="v2-tools__form">
            {!draft.replaces && podIds.length > 1 && (
              <label className="v2-tools__field">
                <span>{t('tools.toRoom', { defaultValue: 'room' })}</span>
                <select className="v2-connectors__select" value={draft.podId} onChange={(event) => { const podId = event.target.value; setDraft({ ...draft, podId, audience: (seats[podId] || []).map((seat) => seat.userId).filter((id): id is string => Boolean(id)) }); }}>
                  {podIds.map((podId) => <option key={podId} value={podId}>{podName(podId)}</option>)}
                </select>
              </label>
            )}
            {draftEntry.connections.length > 1 && (
              <label className="v2-tools__field">
                <span>{t('tools.connection', { defaultValue: 'connection' })}</span>
                <select className="v2-connectors__select" value={draft.connectionId} onChange={(event) => setDraft({ ...draft, connectionId: event.target.value })}>
                  {draftEntry.connections.map((connection) => <option key={connection.connectionId} value={connection.connectionId}>{connection.owner}/{connection.repo}</option>)}
                </select>
              </label>
            )}
            <div className="v2-tools__field">
              <span>{t('tools.mode', { defaultValue: 'what it may do' })}</span>
              <div className="v2-connector-aside__mode" role="group" aria-label={t('tools.mode', { defaultValue: 'what it may do' })}>
                {(['read', 'write-with-confirm', 'write'] as GrantWriteMode[]).map((mode) => (
                  <button key={mode} type="button" aria-pressed={draft.writeMode === mode} className={draft.writeMode === mode ? 'v2-connector-aside__mode-opt v2-connector-aside__mode-opt--on' : 'v2-connector-aside__mode-opt'} onClick={() => setDraft({ ...draft, writeMode: mode })}>
                    {modeLabel(mode)}
                  </button>
                ))}
              </div>
              <span className="v2-tools__hint">{tools.length ? tools.map((tool) => <code key={tool}>{tool}</code>) : t('tools.noTools', { defaultValue: 'no tools on the allow-list' })}</span>
              <span className="v2-tools__hint">{asks}</span>
            </div>
            <fieldset className="v2-tools__field v2-tools__agents">
              <legend>{t('tools.agents', { defaultValue: 'agents' })}</legend>
              {podSeats.length === 0 && <span className="v2-tools__hint">{t('tools.noSeats', { defaultValue: 'no agent in this room yet' })}</span>}
              {podSeats.map((seat) => seat.userId && (
                <label key={seat.userId} className="v2-connector-aside__relay">
                  <input type="checkbox" checked={draft.audience.includes(seat.userId)} onChange={(event) => setDraft({ ...draft, audience: event.target.checked ? [...draft.audience, seat.userId as string] : draft.audience.filter((id) => id !== seat.userId) })} />
                  {seat.displayName || seat.name}
                </label>
              ))}
            </fieldset>
            <label className="v2-tools__field">
              <span>{t('tools.ends', { defaultValue: 'ends' })}</span>
              <select className="v2-connectors__select" value={draft.expiryDays} onChange={(event) => setDraft({ ...draft, expiryDays: Number(event.target.value) as 7 | 30 | 90 })}>
                <option value={7}>{t('tools.days', { defaultValue: 'in {{count}} days', count: 7 })}</option>
                <option value={30}>{t('tools.days', { defaultValue: 'in {{count}} days', count: 30 })}</option>
                <option value={90}>{t('tools.days', { defaultValue: 'in {{count}} days', count: 90 })}</option>
              </select>
            </label>
          </div>
          <div className="v2-connector-aside__actions">
            <button type="button" className="v2-connector-aside__primary" disabled={busy || !draft.connectionId || !draft.podId || tools.length === 0} onClick={() => { void submitDraft(); }}>
              {busy ? t('tools.granting', { defaultValue: 'Granting…' }) : t('tools.grantAct', { defaultValue: 'Grant' })}
            </button>
            <button type="button" className="v2-connector-aside__secondary" disabled={busy} onClick={() => setDraft(null)}>
              {t('tools.cancel', { defaultValue: 'Cancel' })}
            </button>
          </div>
          {error && <p className="v2-connector-aside__note" role="alert">{error}</p>}
        </section>
      </aside>
    );
  };

  const renderAside = (grant: ToolGrant) => {
    const dead = isDead(grant);
    const podId = grantPodId(grant);
    const granter = memberName(grant.grantedBy);
    const entry = entryFor(grant);
    const counts = trail?.counts;
    return (
      <aside className="v2-connectors__aside v2-tools__aside" aria-label={t('tools.grantDetails', { defaultValue: 'Grant details' })}>
        <section className="v2-connector-aside__card">
          <p className="v2-connector-aside__eyebrow">{t('tools.grant', { defaultValue: 'grant' })}</p>
          <h2>{toolLabel(grant)} · {grant.target.kind === 'pod' ? podName(grant.target.id) : seatLabel(podId, grant.target.id)}</h2>
          <p>
            {granter
              ? t('tools.grantedByOn', { defaultValue: 'Granted by {{member}} {{rel}}.', member: granter, rel: relativeTime(grant.createdAt) })
              : t('tools.grantedOn', { defaultValue: 'Granted {{rel}}.', rel: relativeTime(grant.createdAt) })}
            {' '}
            {grant.revokedAt
              ? t('tools.endedRevoked', { defaultValue: 'Revoked {{rel}}.', rel: relativeTime(grant.revokedAt) })
              : (isExpired(grant)
                ? t('tools.endedExpired', { defaultValue: 'Expired {{rel}}.', rel: relativeTime(grant.expiresAt) })
                : t('tools.endsRel', { defaultValue: 'Ends {{rel}}.', rel: relativeTime(grant.expiresAt) }))}
          </p>
          <dl className="v2-tools__facts">
            <dt>{t('tools.agentsAllowed', { defaultValue: 'agents allowed' })}</dt>
            <dd>{audienceLabels(grant)}</dd>
            <dt><span className="v2-tools__mode" aria-hidden="true"><ModeGlyph mode={grant.writeMode} /></span>{modeLabel(grant.writeMode)}</dt>
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
              {entry && (
                <button type="button" className="v2-connector-aside__secondary" onClick={() => openDraft(entry, grant)}>
                  {t('tools.changeAccess', { defaultValue: 'Change access' })}
                </button>
              )}
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
                  <span><span className="v2-tools__outcome" title={line.outcome} aria-hidden="true"><OutcomeGlyph outcome={line.outcome} /></span>{seatLabel(podId, line.agentUserId)} · {line.tool} · {line.outcome}</span>
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
            {moreCount > 0 && ` · ${t('tools.moreCount', { defaultValue: '{{count}} more', count: moreCount })}`}
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
      {draft ? renderDraft() : (selected ? renderAside(selected) : null)}
    </div>
  );
};

export default V2ConnectorTools;
