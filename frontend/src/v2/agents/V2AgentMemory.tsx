import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import axios from '../../utils/axiosConfig';
import V2Avatar from '../components/V2Avatar';
import { usePhone } from '../connectors/usePhone';
import { useTalkToAgent } from './useTalkToAgent';
import { localizeRelativeTime } from '../utils/localizeRelativeTime';
import '../primitives/primitives.css';
import './V2AgentMemory.css';

// Owner/admin memory index, as served by GET /api/agent-memory/:agentName/:instanceId.
interface MemoryNote { header: string; snippet: string }
interface MemorySection { key: string; label: string; kind: string; updatedAt?: string | null; notes: MemoryNote[] }
interface MemoryIndex { viewerRole: 'owner' | 'admin'; totalEntries: number; sections: MemorySection[] }

// Which backend sections land in which group, in the d215 frame's order. Journal
// is the dated log. Soul is the agent's identity and shared is the memory other
// agents can read; each has its own group. Long-term memory is split by its own
// headings (see splitLongTerm). Any other section lands in How I work so nothing
// is hidden. Change the mapping here only.
export const MEMORY_GROUPS = [
  { id: 'rules', label: 'Rules' },
  { id: 'how', label: 'How I work' },
  { id: 'journal', label: 'Journal' },
  { id: 'identity', label: 'Identity' },
  { id: 'shared', label: 'Shared' },
] as const;

type GroupId = typeof MEMORY_GROUPS[number]['id'];
interface GroupedSection { key: string; label: string; updatedAt: string | null; notes: MemoryNote[] }

const JOURNAL_KEYS = new Set(['daily', 'cycles']);
// A long_term heading whose first word names a rule goes under Rules.
const RULE_HEADING = /^(rules?|never|always|don'?t)\b/i;

const sectionGroup = (key: string): GroupId => {
  if (JOURNAL_KEYS.has(key)) return 'journal';
  if (key === 'soul') return 'identity';
  if (key === 'shared') return 'shared';
  return 'how';
};

// Splits a long_term section's headings into Rules and How I work. The
// "Overview" note (text before the first heading) is How I work.
export const splitLongTerm = (section: MemorySection): Record<'rules' | 'how', GroupedSection | null> => {
  const rules = section.notes.filter((n) => RULE_HEADING.test(n.header));
  const how = section.notes.filter((n) => !RULE_HEADING.test(n.header));
  const make = (notes: MemoryNote[]): GroupedSection | null => (
    notes.length ? { key: section.key, label: section.label, updatedAt: section.updatedAt ?? null, notes } : null
  );
  return { rules: make(rules), how: make(how) };
};

export const groupSections = (sections: MemorySection[]) => {
  const byGroup: Record<GroupId, GroupedSection[]> = {
    rules: [], how: [], journal: [], identity: [], shared: [],
  };
  for (const s of sections) {
    if (s.key === 'long_term') {
      const split = splitLongTerm(s);
      if (split.rules) byGroup.rules.push(split.rules);
      if (split.how) byGroup.how.push(split.how);
      continue;
    }
    byGroup[sectionGroup(s.key)].push({ key: s.key, label: s.label, updatedAt: s.updatedAt ?? null, notes: s.notes });
  }
  return MEMORY_GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    sections: byGroup[g.id],
  }));
};

// Frame icons (docs/design/artboards/d215, #s-memory): stroke-only, 1.8 weight.
const ICON_PATHS: Record<'pin' | 'brain' | 'cal' | 'id' | 'share' | 'search' | 'info' | 'chev' | 'chat' | 'back', React.ReactNode> = {
  chev: <path d="m6 9 6 6 6-6" />,
  back: <path d="M19 12H5M12 19l-7-7 7-7" />,
  chat: <path d="M21 12a8 8 0 0 1-11.8 7L3 21l2-6.2A8 8 0 1 1 21 12z" />,
  pin: <path d="M12 17v5M8 3h8l-1 6 3 4H6l3-4z" />,
  brain: <path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a2 2 0 0 0-3-1zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1" />,
  cal: <><rect x="3" y="5" width="18" height="16" rx="2.5" /><path d="M3 10h18M8 3v4M16 3v4" /></>,
  id: <><rect x="3" y="5" width="18" height="14" rx="2.5" /><circle cx="9" cy="12" r="2.4" /><path d="M14 10h4M14 14h3" /></>,
  share: <><circle cx="18" cy="5" r="2.5" /><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="19" r="2.5" /><path d="m8.2 10.8 7.6-4.4M8.2 13.2l7.6 4.4" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" /></>,
};
const MemIcon: React.FC<{ name: keyof typeof ICON_PATHS; size?: number; className?: string }> = ({ name, size = 16, className }) => (
  <svg className={`i${className ? ` ${className}` : ''}`} viewBox="0 0 24 24" width={size} height={size} aria-hidden="true"
    fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    {ICON_PATHS[name]}
  </svg>
);
const GROUP_ICON: Record<GroupId, 'pin' | 'brain' | 'cal' | 'id' | 'share'> = {
  rules: 'pin', how: 'brain', journal: 'cal', identity: 'id', shared: 'share',
};

// The frame marks an empty group with a dash, not a zero.
const countLabel = (n: number) => (n > 0 ? String(n) : '—');

// Journal headers arrive as ISO days (2026-10-28); the frame prints "Oct 28".
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
// The newest ISO day across the journal's sections (daily and cycles each keep
// their own order), else the first header.
export const latestDay = (sections: GroupedSection[]) => {
  const headers = sections.flatMap((sec) => sec.notes.map((n) => n.header.trim()));
  const days = headers.filter((h) => ISO_DAY.test(h)).sort();
  return days.length ? days[days.length - 1] : (headers[0] ?? '');
};

export const journalDay = (header: string, language: string) => {
  const m = ISO_DAY.exec(header.trim());
  if (!m) return header;
  const day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return day.toLocaleDateString(language || undefined, { month: 'short', day: 'numeric' });
};

// The D215 frame without entries: same nav and body, the state sits inside it.
const MemoryShell: React.FC<{ loading: boolean; message: string; loadingLabel: string; query: string; setQuery: (q: string) => void; searchLabel: string; navLabel: string; groupLabel: (id: GroupId, fallback: string) => string }> = ({ loading, message, loadingLabel, query, setQuery, searchLabel, navLabel, groupLabel }) => (
  <div className="v2m-mem">
    <nav className="v2m-mnav" aria-label={navLabel}>
      <ul>
        {MEMORY_GROUPS.map((g) => (
          <li key={g.id}>
            <span className="v2m-navitem">
              <MemIcon name={GROUP_ICON[g.id]} />
              {groupLabel(g.id, g.label)}
              <span className="mo">{countLabel(0)}</span>
            </span>
          </li>
        ))}
      </ul>
      <label className="v2m-search">
        <MemIcon name="search" size={15} />
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={searchLabel} aria-label={searchLabel} />
      </label>
    </nav>
    <div className="v2m-body">
      <p className="v2m-state" role="status">{loading ? loadingLabel : message}</p>
    </div>
  </div>
);

const V2AgentMemory: React.FC = () => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  // Phone (frame 390): the tabs leave the bar for a full-width row, and only the
  // first group starts open. Both are render decisions, so not CSS alone.
  const phone = usePhone('(max-width: 767px)');
  const { agentName = '', instanceId = '' } = useParams<{ agentName: string; instanceId: string }>();
  const [index, setIndex] = useState<MemoryIndex | null>(null);
  // private: the API refused (403), so the viewer is neither the owner nor an
  // admin. failed: anything else went wrong. Neither may read as "no memory".
  const [state, setState] = useState<'loading' | 'ready' | 'private' | 'failed'>('loading');
  const [query, setQuery] = useState('');
  const [activeGroup, setActiveGroup] = useState<GroupId | null>(null);
  const { talkTo, opening: openingRoom, failed: roomError } = useTalkToAgent(agentName, instanceId);
  // Public header facts (name, avatar, pod count). Readable by any viewer, so the
  // shell renders the same for owners, admins and everyone else.
  const [head, setHead] = useState<{ displayName: string; profilePicture?: string; pods: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    axios
      .get(`/api/agent-profile/${encodeURIComponent(agentName)}/${encodeURIComponent(instanceId || 'default')}`)
      .then((res) => {
        if (!cancelled) setHead({ displayName: res.data?.agent?.displayName || agentName, profilePicture: res.data?.agent?.profilePicture, pods: res.data?.pods?.count ?? 0 });
      })
      .catch(() => { if (!cancelled) setHead(null); });
    return () => { cancelled = true; };
  }, [agentName, instanceId]);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    axios
      .get<MemoryIndex>(`/api/agent-memory/${encodeURIComponent(agentName)}/${encodeURIComponent(instanceId || 'default')}`)
      .then((res) => {
        if (cancelled) return;
        setIndex(res.data);
        setState('ready');
      })
      .catch((err) => {
        if (!cancelled) setState(err?.response?.status === 403 ? 'private' : 'failed');
      });
    return () => { cancelled = true; };
  }, [agentName, instanceId]);

  const profileHref = `/v2/agent/${encodeURIComponent(agentName)}/${encodeURIComponent(instanceId)}`;
  const settingsHref = `/v2/agents/${encodeURIComponent(agentName)}/${encodeURIComponent(instanceId)}`;
  const memoryLabel = t('agentSettings.memory', { defaultValue: 'Memory' });
  const searchLabel = t('agentProfile.memory.search', { defaultValue: 'Search memory' });
  const groupLabel = (id: GroupId, fallback: string) => t(`agentProfile.memory.groups.${id}`, { defaultValue: fallback });
  // Until the profile loads, name the agent by its instance: for runtime-hosted
  // agents the route's agentName is the runtime ("openclaw"), never the agent.
  const agentLabel = head?.displayName || (instanceId && instanceId !== 'default' ? instanceId : agentName);
  const shellMessage = state === 'private'
    ? t('agentProfile.memory.private', { name: agentLabel })
    : t('agentProfile.memory.loadFailed');

  const tabs = (
    <nav className="v2p-seg" aria-label={t('agentSettings.tabs')}>
      <button type="button" onClick={() => navigate(profileHref)}>{t('agentSettings.profile')}</button>
      <button type="button" className="on" aria-current="page">{memoryLabel}</button>
      <button type="button" onClick={() => navigate(settingsHref)}>{t('agentSettings.settings')}</button>
    </nav>
  );

  return (
    <main className="v2m-page">
      <header className="v2p-ph">
        {phone && (
          <button type="button" className="v2p-b v2p-b-g v2p-ib v2m-back" title={t('agentSettings.yourTeam')} aria-label={t('agentSettings.yourTeam')} onClick={() => navigate('/v2/agents')}>
            <MemIcon name="back" size={17} />
          </button>
        )}
        <V2Avatar name={agentLabel} src={head?.profilePicture} size="lg" kind="agent" seed={`${agentName}:${instanceId}`} />
        <div className="v2m-ahead">
          <h1>{agentLabel}</h1>
          {head && <p className="st">{t('agentProfile.hero.activeInPods', { count: head.pods })}</p>}
        </div>
        <span className="sp" />
        {!phone && tabs}
        <span className="sp" />
        <button
          type="button"
          className="v2p-b v2p-b-s v2p-ib"
          title={t('agentProfile.hero.talkTo', { name: agentLabel })}
          aria-label={t('agentProfile.hero.talkTo', { name: agentLabel })}
          onClick={() => { void talkTo(); }}
          disabled={openingRoom}
        >
          <MemIcon name="chat" size={17} />
        </button>
      </header>
      {roomError && <p className="v2m-state" role="alert">{t('agentProfile.hero.openRoomFailed')}</p>}
      <div className="v2m-pbody">
      {phone && tabs}
      {state === 'ready' && index ? null : <MemoryShell loading={state === 'loading'} message={shellMessage} loadingLabel={t('common.loading', { defaultValue: 'Loading…' })} query={query} setQuery={setQuery} searchLabel={searchLabel} navLabel={memoryLabel} groupLabel={groupLabel} />}
      {state === 'ready' && index && (() => {
        const needle = query.trim().toLowerCase();
        const groups = groupSections(index.sections)
          .map((group) => ({
            ...group,
            sections: group.sections
              .map((sec) => ({
                ...sec,
                notes: needle
                  ? sec.notes.filter((n) => `${n.header} ${n.snippet}`.toLowerCase().includes(needle))
                  : sec.notes,
              }))
              .filter((sec) => sec.notes.length > 0),
          }));
        const firstShown = groups.find((g) => g.sections.length > 0)?.id;
        const hasNotes = groups.some((g) => g.sections.length > 0);
        // The frame marks one nav item as current: the one clicked, else the first with notes.
        const current = groups.find((g) => g.id === activeGroup && g.sections.length > 0)?.id ?? firstShown;
        return (
          <div className="v2m-mem">
            <nav className="v2m-mnav" aria-label={memoryLabel}>
              <ul>
                {groups.map((group) => {
                  const count = group.sections.reduce((n, s) => n + s.notes.length, 0);
                  const inner = (
                    <>
                      <MemIcon name={GROUP_ICON[group.id]} />
                      {groupLabel(group.id, group.label)}
                      <span className="mo">{countLabel(count)}</span>
                    </>
                  );
                  // An empty group has nowhere to jump to, so it is a label, not a link.
                  return (
                    <li key={group.id}>
                      {count > 0 ? (
                        <a href={`#memory-group-${group.id}`} className={group.id === current ? 'on' : undefined} aria-current={group.id === current ? 'true' : undefined} onClick={() => setActiveGroup(group.id)}>
                          {inner}
                        </a>
                      ) : <span className="v2m-navitem">{inner}</span>}
                    </li>
                  );
                })}
              </ul>
              <label className="v2m-search">
                <MemIcon name="search" size={15} />
                <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={searchLabel} aria-label={searchLabel} />
              </label>
            </nav>
            <div className="v2m-body">
              {!hasNotes && (
                <p className="v2m-state" role="status">
                  {needle
                    ? t('agentProfile.memory.noMatch', { query: query.trim() })
                    : t('agentProfile.memory.none', { defaultValue: 'No memory recorded yet.' })}
                </p>
              )}
              {groups.filter((g) => g.sections.length > 0).map((group) => {
                // One time per group: the newest section update in it. Never per note.
                const updated = group.sections.map((s) => s.updatedAt).filter(Boolean).sort().pop() ?? null;
                return (
                  <details key={group.id} id={`memory-group-${group.id}`} className="v2m-grp" open={!phone || group.id === firstShown}>
                    <summary className="v2m-gtitle">
                      <span role="heading" aria-level={2} className="v2m-gheading">
                        <MemIcon name={GROUP_ICON[group.id]} size={13} />
                        {groupLabel(group.id, group.label)}
                        <span className="v2m-ct">{group.sections.reduce((n, sec) => n + sec.notes.length, 0)}</span>
                      </span>
                      {group.id === 'journal' && (
                        <span className="v2m-latest">{journalDay(latestDay(group.sections), i18n.language)}</span>
                      )}
                      {updated && (
                        <span className="v2m-saved">
                          {t('agentProfile.memory.sectionUpdated', { defaultValue: 'Section updated {{when}}', when: localizeRelativeTime(updated, t) })}
                        </span>
                      )}
                      {group.id === firstShown && (
                        <button type="button" className="v2m-info" aria-label={t('agentProfile.memory.moreAbout', { defaultValue: 'More about this' })}>
                          <MemIcon name="info" size={15} />
                          <span className="tip" role="tooltip">{t('agentProfile.memory.privacy', { defaultValue: 'Memory is private to you and the agent. The agent writes it.' })}</span>
                        </button>
                      )}
                      <MemIcon name="chev" size={13} className="v2m-chev" />
                    </summary>
                    <ul className="v2p-list v2m-list">
                      {group.sections.flatMap((sec) => sec.notes).map((n, i) => (
                        group.id === 'journal' ? (
                          <li key={i} className="v2m-jday">
                            <span className="mo">{journalDay(n.header, i18n.language)}</span>
                            {n.snippet
                              ? <span>{n.snippet}</span>
                              : <span className="v2m-mu">{t('agentProfile.memory.noEntry')}</span>}
                          </li>
                        ) : (
                          <li key={i} className="v2m-mnote">
                            <MemIcon name={GROUP_ICON[group.id]} />
                            <div>
                              <div className="tx">{n.header}</div>
                              {n.snippet && <div className="snip">{n.snippet}</div>}
                            </div>
                          </li>
                        )
                      ))}
                    </ul>
                  </details>
                );
              })}
            </div>
          </div>
        );
      })()}
      </div>
    </main>
  );
};

export default V2AgentMemory;
