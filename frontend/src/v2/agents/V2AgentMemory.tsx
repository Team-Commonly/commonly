import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import axios from '../../utils/axiosConfig';
import V2Avatar from '../components/V2Avatar';
import { localizeRelativeTime } from '../utils/localizeRelativeTime';
import '../primitives/primitives.css';
import './V2AgentMemory.css';

// Owner/admin memory index, as served by GET /api/agent-memory/:agentName/:instanceId.
interface MemoryNote { header: string; snippet: string }
interface MemorySection { key: string; label: string; kind: string; updatedAt?: string | null; notes: MemoryNote[] }
interface MemoryIndex { viewerRole: 'owner' | 'admin'; totalEntries: number; sections: MemorySection[] }

// Which backend sections land in which group. Journal is the dated log. Soul
// is a rule-like section and sits at the top of Rules. Long-term memory is split
// by its own headings (see splitLongTerm). Any other section lands in How I work
// so nothing is hidden. Change the mapping here only.
export const MEMORY_GROUPS = [
  { id: 'rules', label: 'Rules' },
  { id: 'how', label: 'How I work' },
  { id: 'journal', label: 'Journal' },
] as const;

type GroupId = typeof MEMORY_GROUPS[number]['id'];
interface GroupedSection { key: string; label: string; updatedAt: string | null; notes: MemoryNote[] }

const JOURNAL_KEYS = new Set(['daily', 'cycles']);
// A long_term heading whose first word names a rule goes under Rules.
const RULE_HEADING = /^(rules?|never|always|don'?t)\b/i;

const sectionGroup = (key: string): GroupId => (JOURNAL_KEYS.has(key) ? 'journal' : 'how');

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
  const byGroup: Record<GroupId, GroupedSection[]> = { rules: [], how: [], journal: [] };
  // Soul first, so it leads Rules.
  const soul = sections.find((s) => s.key === 'soul');
  if (soul) byGroup.rules.push({ key: soul.key, label: soul.label, updatedAt: soul.updatedAt ?? null, notes: soul.notes });
  for (const s of sections) {
    if (s.key === 'soul') continue;
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
const ICON_PATHS: Record<'pin' | 'brain' | 'cal' | 'search' | 'info' | 'chev' | 'chat', React.ReactNode> = {
  chev: <path d="m6 9 6 6 6-6" />,
  chat: <path d="M21 12a8 8 0 0 1-11.8 7L3 21l2-6.2A8 8 0 1 1 21 12z" />,
  pin: <path d="M12 17v5M8 3h8l-1 6 3 4H6l3-4z" />,
  brain: <path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a2 2 0 0 0-3-1zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1" />,
  cal: <><rect x="3" y="5" width="18" height="16" rx="2.5" /><path d="M3 10h18M8 3v4M16 3v4" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" /></>,
};
const MemIcon: React.FC<{ name: keyof typeof ICON_PATHS; size?: number; className?: string }> = ({ name, size = 16, className }) => (
  <svg className={`i${className ? ` ${className}` : ''}`} viewBox="0 0 24 24" width={size} height={size} aria-hidden="true"
    fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    {ICON_PATHS[name]}
  </svg>
);
const GROUP_ICON: Record<GroupId, 'pin' | 'brain' | 'cal'> = { rules: 'pin', how: 'brain', journal: 'cal' };

// The D215 frame without entries: same nav and body, the state sits inside it.
const MemoryShell: React.FC<{ loading: boolean; message: string; loadingLabel: string; query: string; setQuery: (q: string) => void; searchLabel: string; navLabel: string }> = ({ loading, message, loadingLabel, query, setQuery, searchLabel, navLabel }) => (
  <div className="v2m-mem">
    <nav className="v2m-mnav" aria-label={navLabel}>
      <ul>
        {MEMORY_GROUPS.map((g) => (
          <li key={g.id}>
            <span className="v2m-navitem">
              <MemIcon name={GROUP_ICON[g.id]} />
              {g.label}
              <span className="mo">0</span>
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
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { agentName = '', instanceId = '' } = useParams<{ agentName: string; instanceId: string }>();
  const [index, setIndex] = useState<MemoryIndex | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'denied'>('loading');
  const [query, setQuery] = useState('');
  const [openingRoom, setOpeningRoom] = useState(false);
  const [roomError, setRoomError] = useState(false);
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
      .catch(() => {
        if (!cancelled) setState('denied');
      });
    return () => { cancelled = true; };
  }, [agentName, instanceId]);

  // Same idempotent room endpoint as the profile and Your Team entry points:
  // returns the existing DM or opens one.
  const talkTo = async () => {
    setOpeningRoom(true);
    setRoomError(false);
    try {
      const res = await axios.post<{ room?: { _id?: string } }>('/api/agents/runtime/room', { agentName, instanceId: instanceId || 'default' });
      const roomId = res.data?.room?._id;
      if (!roomId) throw new Error('Agent room not returned');
      navigate(`/v2/pods/${roomId}`);
    } catch {
      setRoomError(true);
      setOpeningRoom(false);
    }
  };

  const profileHref = `/v2/agent/${encodeURIComponent(agentName)}/${encodeURIComponent(instanceId)}`;
  const settingsHref = `/v2/agents/${encodeURIComponent(agentName)}/${encodeURIComponent(instanceId)}`;
  const memoryLabel = t('agentSettings.memory', { defaultValue: 'Memory' });
  const searchLabel = t('agentProfile.memory.search', { defaultValue: 'Search memory' });

  return (
    <main className="v2m-page">
      <header className="v2p-ph">
        <V2Avatar name={head?.displayName || agentName} src={head?.profilePicture} size="lg" kind="agent" seed={`${agentName}:${instanceId}`} />
        <div className="v2m-ahead">
          <h1>{head?.displayName || agentName}</h1>
          {head && <p className="st">{t('agentProfile.hero.activeInPods', { count: head.pods })}</p>}
        </div>
        <span className="sp" />
        <nav className="v2p-seg" aria-label={t('agentSettings.tabs')}>
          <button type="button" onClick={() => navigate(profileHref)}>{t('agentSettings.profile')}</button>
          <button type="button" className="on" aria-current="page">{memoryLabel}</button>
          <button type="button" onClick={() => navigate(settingsHref)}>{t('agentSettings.settings')}</button>
        </nav>
        <span className="sp" />
        <button
          type="button"
          className="v2p-b v2p-b-s v2p-ib"
          title={t('agentProfile.hero.talkTo', { name: head?.displayName || agentName })}
          aria-label={t('agentProfile.hero.talkTo', { name: head?.displayName || agentName })}
          onClick={() => { void talkTo(); }}
          disabled={openingRoom}
        >
          <MemIcon name="chat" size={17} />
        </button>
      </header>
      {roomError && <p className="v2m-state" role="alert">{t('agentProfile.hero.openRoomFailed')}</p>}
      <div className="v2m-pbody">
      {state === 'ready' && index ? null : <MemoryShell loading={state === 'loading'} message={state === 'denied' ? t('agentProfile.memory.none', { defaultValue: 'No memory recorded yet.' }) : ''} loadingLabel={t('common.loading', { defaultValue: 'Loading…' })} query={query} setQuery={setQuery} searchLabel={searchLabel} navLabel={memoryLabel} />}
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
        return (
          <div className="v2m-mem">
            <nav className="v2m-mnav" aria-label={memoryLabel}>
              <ul>
                {groups.map((group) => (
                  <li key={group.id}>
                    <a href={`#memory-group-${group.id}`}>
                      <MemIcon name={GROUP_ICON[group.id]} />
                      {group.label}
                      <span className="mo">{group.sections.reduce((n, s) => n + s.notes.length, 0)}</span>
                    </a>
                  </li>
                ))}
              </ul>
              <label className="v2m-search">
                <MemIcon name="search" size={15} />
                <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={searchLabel} aria-label={searchLabel} />
              </label>
            </nav>
            <div className="v2m-body">
              {groups.filter((g) => g.sections.length > 0).map((group) => {
                // One time per group: the newest section update in it. Never per note.
                const updated = group.sections.map((s) => s.updatedAt).filter(Boolean).sort().pop() ?? null;
                return (
                  <details key={group.id} id={`memory-group-${group.id}`} className="v2m-grp" open>
                    <summary className="v2m-gtitle">
                      <span role="heading" aria-level={2} className="v2m-gheading">
                        <MemIcon name={GROUP_ICON[group.id]} size={13} />
                        {group.label}
                      </span>
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
                            <span className="mo">{n.header}</span>
                            <span>{n.snippet}</span>
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
