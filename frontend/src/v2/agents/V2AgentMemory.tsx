import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import axios from '../../utils/axiosConfig';
import V2PageHead from '../components/V2PageHead';
import './v2-agent-settings.css';

// Owner/admin memory index, as served by GET /api/agent-memory/:agentName/:instanceId.
interface MemoryNote { header: string; snippet: string }
interface MemorySection { key: string; label: string; kind: string; notes: MemoryNote[] }
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
interface GroupedSection { key: string; label: string; notes: MemoryNote[] }

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
    notes.length ? { key: section.key, label: section.label, notes } : null
  );
  return { rules: make(rules), how: make(how) };
};

export const groupSections = (sections: MemorySection[]) => {
  const byGroup: Record<GroupId, GroupedSection[]> = { rules: [], how: [], journal: [] };
  // Soul first, so it leads Rules.
  const soul = sections.find((s) => s.key === 'soul');
  if (soul) byGroup.rules.push({ key: soul.key, label: soul.label, notes: soul.notes });
  for (const s of sections) {
    if (s.key === 'soul') continue;
    if (s.key === 'long_term') {
      const split = splitLongTerm(s);
      if (split.rules) byGroup.rules.push(split.rules);
      if (split.how) byGroup.how.push(split.how);
      continue;
    }
    byGroup[sectionGroup(s.key)].push({ key: s.key, label: s.label, notes: s.notes });
  }
  return MEMORY_GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    sections: byGroup[g.id],
  }));
};

// Frame icons (docs/design/artboards/d215, #s-memory): stroke-only, 1.8 weight.
const ICON_PATHS: Record<'pin' | 'brain' | 'cal' | 'search' | 'info', React.ReactNode> = {
  pin: <path d="M12 17v5M8 3h8l-1 6 3 4H6l3-4z" />,
  brain: <path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a2 2 0 0 0-3-1zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1" />,
  cal: <><rect x="3" y="5" width="18" height="16" rx="2.5" /><path d="M3 10h18M8 3v4M16 3v4" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" /></>,
};
const MemIcon: React.FC<{ name: keyof typeof ICON_PATHS; size?: number }> = ({ name, size = 16 }) => (
  <svg className="v2-agent-memory__icon" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true"
    fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    {ICON_PATHS[name]}
  </svg>
);
const GROUP_ICON: Record<GroupId, 'pin' | 'brain' | 'cal'> = { rules: 'pin', how: 'brain', journal: 'cal' };

const V2AgentMemory: React.FC = () => {
  const { t } = useTranslation();
  const { agentName = '', instanceId = '' } = useParams<{ agentName: string; instanceId: string }>();
  const [index, setIndex] = useState<MemoryIndex | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'denied'>('loading');
  const [query, setQuery] = useState('');

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

  const profileHref = `/v2/agent/${encodeURIComponent(agentName)}/${encodeURIComponent(instanceId)}`;
  const settingsHref = `/v2/agents/${encodeURIComponent(agentName)}/${encodeURIComponent(instanceId)}`;

  return (
    <main className="v2-agent-settings">
      <V2PageHead title={t('agentSettings.memory', { defaultValue: 'Memory' })} />
      <nav className="v2-agent-settings__tabs" aria-label={t('agentSettings.tabs')}>
        <Link to={profileHref}>{t('agentSettings.profile')}</Link>
        <Link to={settingsHref}>{t('agentSettings.settings')}</Link>
        <span aria-current="page">{t('agentSettings.memory', { defaultValue: 'Memory' })}</span>
      </nav>

      {state === 'loading' && <p className="v2-agent-settings__muted">{t('common.loading', { defaultValue: 'Loading…' })}</p>}
      {state === 'denied' && (
        <p className="v2-agent-settings__muted" role="status">
          {t('agentProfile.memory.none', { defaultValue: 'Memory is visible to the agent owner and admins.' })}
        </p>
      )}
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
        return (
          <div className="v2-agent-memory">
            <aside className="v2-agent-memory__nav" aria-label={t('agentSettings.memory', { defaultValue: 'Memory' })}>
              <ul>
                {groups.map((group) => (
                  <li key={group.id}>
                    <a href={`#memory-group-${group.id}`}>
                      <MemIcon name={GROUP_ICON[group.id]} />
                      {group.label}
                      <span className="v2-agent-memory__count">{group.sections.reduce((n, s) => n + s.notes.length, 0)}</span>
                    </a>
                  </li>
                ))}
              </ul>
              <label className="v2-agent-memory__search">
                <MemIcon name="search" size={15} />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('agentProfile.memory.search', { defaultValue: 'Search memory' })}
                  aria-label={t('agentProfile.memory.search', { defaultValue: 'Search memory' })}
                />
              </label>
            </aside>
            <div className="v2-agent-memory__body">
              {groups.filter((g) => g.sections.length > 0).map((group) => (
                <section key={group.id} className="v2-agent-memory__group" aria-labelledby={`memory-group-${group.id}`}>
                  <h2 id={`memory-group-${group.id}`} className="v2-agent-memory__gtitle">
                    <MemIcon name={GROUP_ICON[group.id]} size={13} />
                    {group.label}
                  </h2>
                  <ul className="v2-agent-memory__list">
                    {group.sections.flatMap((sec) => sec.notes).map((n, i) => (
                      group.id === 'journal' ? (
                        <li key={i} className="v2-agent-memory__jday">
                          <span className="v2-agent-memory__jdate">{n.header}</span>
                          <span>{n.snippet}</span>
                        </li>
                      ) : (
                        <li key={i} className="v2-agent-memory__mnote">
                          <MemIcon name={GROUP_ICON[group.id]} />
                          <div>
                            <div className="v2-agent-memory__tx">{n.header}</div>
                            {n.snippet && <div className="v2-agent-memory__snip">{n.snippet}</div>}
                          </div>
                        </li>
                      )
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </div>
        );
      })()}
    </main>
  );
};

export default V2AgentMemory;
