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

const V2AgentMemory: React.FC = () => {
  const { t } = useTranslation();
  const { agentName = '', instanceId = '' } = useParams<{ agentName: string; instanceId: string }>();
  const [index, setIndex] = useState<MemoryIndex | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'denied'>('loading');

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
      {state === 'ready' && index && groupSections(index.sections).filter((g) => g.sections.length > 0).map((group) => (
        <section key={group.id} className="v2-agent-settings__section" aria-labelledby={`memory-group-${group.id}`}>
          <h2 id={`memory-group-${group.id}`} className="v2-agent-settings__section-title">
            {group.label}
            <span className="v2-aprofile__count">{group.sections.reduce((n, s) => n + s.notes.length, 0)}</span>
          </h2>
          {group.sections.map((sec) => (
            <div key={sec.key} className="v2-agent-memory__sec">
              <h3 className="v2-agent-memory__sec-title">{sec.label}</h3>
              <ul className="v2-agent-memory__notes">
                {sec.notes.map((n, i) => (
                  <li key={i} className="v2-agent-memory__note">
                    <span className="v2-agent-memory__note-h">{n.header}</span>
                    {n.snippet && <span className="v2-agent-memory__note-s">{n.snippet}</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ))}
    </main>
  );
};

export default V2AgentMemory;
