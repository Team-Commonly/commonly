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

// Which backend sections land in which group. Rules are what the agent is told
// to do; How I work is how it runs; Journal is what happened. An unknown section
// key falls into How I work so nothing is hidden. Change the mapping here only.
export const MEMORY_GROUPS = [
  { id: 'rules', label: 'Rules', keys: ['soul', 'long_term'] },
  { id: 'how', label: 'How I work', keys: ['shared', 'runtime_meta', 'relationships'] },
  { id: 'journal', label: 'Journal', keys: ['daily', 'cycles'] },
] as const;

const FALLBACK_GROUP = 'how';

export const groupSections = (sections: MemorySection[]) => {
  const byKey = new Map<string, string>();
  MEMORY_GROUPS.forEach((g) => g.keys.forEach((k) => byKey.set(k, g.id)));
  return MEMORY_GROUPS.map((g) => ({
    ...g,
    sections: sections.filter((s) => (byKey.get(s.key) || FALLBACK_GROUP) === g.id),
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
      {state === 'ready' && index && groupSections(index.sections).map((group) => (
        <section key={group.id} className="v2-agent-settings__section" aria-labelledby={`memory-group-${group.id}`}>
          <h2 id={`memory-group-${group.id}`} className="v2-agent-settings__section-title">
            {group.label}
            <span className="v2-aprofile__count">{group.sections.reduce((n, s) => n + s.notes.length, 0)}</span>
          </h2>
          {group.sections.length === 0 && (
            <p className="v2-agent-settings__muted">{t('agentProfile.memory.none', { defaultValue: 'Nothing here yet.' })}</p>
          )}
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
