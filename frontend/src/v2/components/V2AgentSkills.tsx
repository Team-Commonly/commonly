import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import axios from '../../utils/axiosConfig';
import './v2-agent-skills.css';

interface SkillItem { name: string; description?: string | null; sourceUrl?: string | null }
interface SkillLoad { at: string; mounted: string[]; conflicted: string[]; status?: 'available' | 'unavailable' }
interface SkillsResponse { items: SkillItem[]; canEdit: boolean; skillLoad: SkillLoad | null }
interface CatalogItem extends SkillItem { content?: string; license?: string | { name?: string } }

interface Props { pods: Array<{ id: string; name: string }>; agentName: string; instanceId: string }

const requestError = (error: unknown, fallback: string): string => (
  (error as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback
);

const loadLabel = (skill: SkillItem, load: SkillLoad | null, t: (key: string) => string): string => {
  if (!load) return t('agentSkills.noReport');
  const name = skill.name.toLowerCase();
  if (load.mounted.some((entry) => entry.toLowerCase() === name)) return t('agentSkills.loaded');
  if (load.conflicted.some((entry) => entry.toLowerCase() === name)) return t('agentSkills.conflicted');
  if (load.status === 'unavailable') return t('agentSkills.unavailable');
  return t('agentSkills.notLoaded');
};

const V2AgentSkills: React.FC<Props> = ({ pods, agentName, instanceId }) => {
  const { t } = useTranslation();
  const [selectedPodId, setSelectedPodId] = useState(pods[0]?.id || '');
  const podId = pods.some((pod) => pod.id === selectedPodId) ? selectedPodId : pods[0]?.id || '';
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [skillLoad, setSkillLoad] = useState<SkillLoad | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const response = await axios.get<SkillsResponse>(`/api/skills/pods/${encodeURIComponent(podId)}/imported`, {
      params: { scope: 'agent', agentName, instanceId },
    });
    setSkills(response.data.items || []);
    setSkillLoad(response.data.skillLoad || null);
    setCanEdit(Boolean(response.data.canEdit));
  }, [podId, agentName, instanceId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setCanEdit(false);
    setSkillLoad(null);
    setError(null);
    axios.get<SkillsResponse>(`/api/skills/pods/${encodeURIComponent(podId)}/imported`, {
      params: { scope: 'agent', agentName, instanceId },
    }).then((response) => {
      if (!active) return;
      setSkills(response.data.items || []);
      setSkillLoad(response.data.skillLoad || null);
      setCanEdit(Boolean(response.data.canEdit));
    }).catch((requestFailure) => {
      if (active) setError(requestError(requestFailure, t('agentSkills.loadError')));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [podId, agentName, instanceId, t]);

  useEffect(() => {
    if (!catalogOpen) return undefined;
    let active = true;
    setCatalog([]);
    setCatalogLoading(true);
    const timer = setTimeout(() => {
      axios.get<{ items: CatalogItem[] }>('/api/skills/catalog', {
        params: { source: 'awesome', limit: 60, q: query.trim() },
      }).then((response) => {
        if (active) setCatalog(response.data.items || []);
      }).catch((requestFailure) => {
        if (active) setError(requestError(requestFailure, t('agentSkills.catalogError')));
      }).finally(() => { if (active) setCatalogLoading(false); });
    }, 150);
    return () => { active = false; clearTimeout(timer); };
  }, [catalogOpen, query, t]);

  const add = async (item: CatalogItem) => {
    if (!canEdit || busy) return;
    setBusy(item.name);
    setError(null);
    try {
      await axios.post('/api/skills/import', {
        podId, name: item.name, content: item.content || undefined,
        sourceUrl: item.sourceUrl || undefined,
        description: item.description || undefined,
        license: typeof item.license === 'string' ? item.license : item.license?.name,
        scope: 'agent', agentName, instanceId,
      });
      await refresh();
      setCatalogOpen(false);
    } catch (requestFailure) {
      setError(requestError(requestFailure, t('agentSkills.addError')));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (name: string) => {
    if (!canEdit || busy) return;
    setBusy(name);
    setError(null);
    try {
      await axios.delete(`/api/skills/pods/${encodeURIComponent(podId)}/imported`, {
        params: { name, scope: 'agent', agentName, instanceId },
      });
      await refresh();
    } catch (requestFailure) {
      setError(requestError(requestFailure, t('agentSkills.removeError')));
    } finally {
      setBusy(null);
    }
  };

  const installed = new Set(skills.map((skill) => skill.name.toLowerCase()));
  const available = catalog.filter((item) => !installed.has(item.name.toLowerCase()));

  return (
    <section className="v2-agent-skills" aria-labelledby="v2-agent-skills-heading">
      <div className="v2-agent-skills__head">
        <h2 id="v2-agent-skills-heading">{t('agentSkills.title')}</h2>
        {canEdit && <button type="button" onClick={() => { setCatalogOpen(!catalogOpen); setError(null); }}>{t(catalogOpen ? 'agentSkills.closeCatalog' : 'agentSkills.addSkill')}</button>}
      </div>
      {pods.length > 1 && <label className="v2-agent-skills__pod-label" htmlFor="v2-agent-skills-pod">{t('agentSkills.pod')}
        <select id="v2-agent-skills-pod" value={podId} onChange={(event) => { setSelectedPodId(event.target.value); setCatalogOpen(false); }}>
          {pods.map((pod) => <option value={pod.id} key={pod.id}>{pod.name}</option>)}
        </select>
      </label>}
      {error && <p role="alert" className="v2-agent-skills__error">{error}</p>}
      {loading ? <p className="v2-agent-skills__empty">{t('agentSkills.loading')}</p> : (
        skills.length ? <div className="v2-agent-skills__list">
          {skills.map((skill) => (
            <div className="v2-agent-skills__row" key={skill.name}>
              <div className="v2-agent-skills__copy">
                <strong>{skill.name}</strong>
                {skill.description && <span>{skill.description}</span>}
                <small>{loadLabel(skill, skillLoad, t)}</small>
              </div>
              {canEdit && <button type="button" disabled={busy !== null} onClick={() => void remove(skill.name)} aria-label={t('agentSkills.removeNamed', { name: skill.name })}>{t('agentSkills.remove')}</button>}
            </div>
          ))}
        </div> : <p className="v2-agent-skills__empty">{t('agentSkills.empty')}</p>
      )}
      {skillLoad?.at && <p className="v2-agent-skills__reported">{t('agentSkills.reported', { date: new Date(skillLoad.at).toLocaleString() })}</p>}
      {catalogOpen && canEdit && <div className="v2-agent-skills__catalog">
        <label htmlFor="v2-agent-skills-search">{t('agentSkills.find')}</label>
        <input id="v2-agent-skills-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('agentSkills.search')} />
        <div className="v2-agent-skills__list">
          {available.map((item) => <div className="v2-agent-skills__row" key={item.name}>
            <div className="v2-agent-skills__copy"><strong>{item.name}</strong>{item.description && <span>{item.description}</span>}</div>
            <button type="button" disabled={busy !== null || (!item.content && !item.sourceUrl)} onClick={() => void add(item)} aria-label={t('agentSkills.addNamed', { name: item.name })}>{t('agentSkills.add')}</button>
          </div>)}
          {catalogLoading && <p className="v2-agent-skills__empty">{t('agentSkills.loading')}</p>}
          {!catalogLoading && available.length === 0 && <p className="v2-agent-skills__empty">{t('agentSkills.noMatches')}</p>}
        </div>
      </div>}
    </section>
  );
};

export default V2AgentSkills;
