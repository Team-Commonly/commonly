import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import axios from '../../utils/axiosConfig';
import type { AgentSettingsInstallation, AgentSettingsPatch } from './useAgentSettings';
import './v2-agent-policy.css';

type MemorySection = 'soul' | 'long_term' | 'shared';
type MemoryDocument = { content: string; updatedAt: string | null; visibility: string };
type MemoryDocuments = Record<MemorySection, MemoryDocument>;
const memorySections: MemorySection[] = ['long_term', 'soul', 'shared'];
const trustAdapters = new Set(['claude', 'codex', 'opencode', 'qwen']);
const message = (error: unknown, fallback: string) => (
  (error as { response?: { data?: { error?: string } } })?.response?.data?.error
  || (error instanceof Error && error.message) || fallback
);

interface Props {
  agentName: string;
  instanceId: string;
  installation: AgentSettingsInstallation | null;
  update: (patch: AgentSettingsPatch) => Promise<unknown>;
}

const V2AgentPolicy: React.FC<Props> = ({ agentName, instanceId, installation, update }) => {
  const { t } = useTranslation();
  const environment = (installation?.config?.environment || {}) as { adapter?: string; sandbox?: { mode?: string } };
  const runtime = installation?.runtime;
  const adapter = String(environment.adapter || runtime?.adapter || runtime?.runtimeType || '')
    .trim().toLowerCase().replace('claude-code', 'claude');
  const canSetTrust = (runtime?.host === 'byo' || runtime?.runtimeType === 'wrapper')
    && trustAdapters.has(adapter);
  const [trustMode, setTrustMode] = useState(environment.sandbox?.mode || '');
  const [quota, setQuota] = useState<{ turnCap: number; userRunCeiling: number | null } | null>(null);
  const [documents, setDocuments] = useState<MemoryDocuments | null>(null);
  const [section, setSection] = useState<MemorySection>('long_term');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ group: 'trust' | 'memory';
    kind: 'error' | 'saved'; text: string } | null>(null);
  const [memoryLoadError, setMemoryLoadError] = useState<string | null>(null);
  const [quotaError, setQuotaError] = useState<string | null>(null);

  useEffect(() => {
    setTrustMode(environment.sandbox?.mode || '');
  }, [installation]);

  const memoryUrl = `/api/agent-memory/${encodeURIComponent(agentName)}/${encodeURIComponent(instanceId)}/editable`;
  const loadMemory = useCallback(async (preserveDraft = false) => {
    const response = await axios.get<{ sections: MemoryDocuments }>(memoryUrl);
    setDocuments(response.data.sections);
    setMemoryLoadError(null);
    if (!preserveDraft) setContent(response.data.sections[section]?.content || '');
  }, [memoryUrl, section]);

  useEffect(() => {
    let current = true;
    setDocuments(null);
    setMemoryLoadError(null);
    setQuotaError(null);
    void axios.get<{ sections: MemoryDocuments }>(memoryUrl).then((response) => {
      if (current) {
        setDocuments(response.data.sections);
        setContent(response.data.sections.long_term?.content || '');
      }
    }).catch((requestError) => { if (current) setMemoryLoadError(message(requestError, t('agentPolicy.loadError'))); });
    void axios.get<{ turnCap: number; userRunCeiling: number | null }>(
      `/api/registry/agents/${encodeURIComponent(agentName)}/manage-settings`, { params: { instanceId } },
    ).then((response) => { if (current) setQuota(response.data); })
      .catch((requestError) => { if (current) setQuotaError(message(requestError, t('agentPolicy.loadError'))); });
    return () => { current = false; };
  }, [agentName, instanceId, memoryUrl, t]);

  // Trust mode autosaves the moment a valid choice is made; there is no Save button.
  const saveTrust = async (mode: string) => {
    if (!canSetTrust || !['read-only', 'workspace'].includes(mode)) return;
    setBusy(true); setFeedback(null);
    try {
      await update({ config: { environment: { sandbox: { mode } } } });
      setFeedback({ group: 'trust', kind: 'saved', text: t('agentPolicy.saved') });
    } catch (requestError) { setFeedback({ group: 'trust', kind: 'error', text: message(requestError, t('agentPolicy.saveError')) }); }
    finally { setBusy(false); }
  };

  const saveMemory = async () => {
    if (!documents) return;
    setBusy(true); setFeedback(null);
    try {
      await axios.patch(`${memoryUrl}/${section}`, {
        content, expectedUpdatedAt: documents[section].updatedAt,
      });
      await loadMemory();
      setFeedback({ group: 'memory', kind: 'saved', text: t('agentPolicy.saved') });
    } catch (requestError) {
      setFeedback({ group: 'memory', kind: 'error', text: message(requestError, t('agentPolicy.saveError')) });
      if ((requestError as { response?: { status?: number } })?.response?.status === 409) {
        await loadMemory(true).catch(() => {});
      }
    } finally { setBusy(false); }
  };

  const changeSection = (next: MemorySection) => {
    setSection(next);
    setContent(documents?.[next]?.content || '');
    setFeedback(null);
  };

  const groupFeedback = (group: 'trust' | 'memory') => feedback?.group === group && (
    <p role={feedback.kind === 'error' ? 'alert' : 'status'}
      className={feedback.kind === 'error' ? 'v2-agent-policy__error' : 'v2-agent-policy__saved'}>{feedback.text}</p>
  );

  return <section className="v2-agent-policy" aria-labelledby="agent-policy-title">
    <h2 id="agent-policy-title">{t('agentPolicy.title')}</h2>
    {canSetTrust && <div className="v2-agent-policy__group">
      <h3>{t('agentPolicy.trust')}</h3>
      <label>{t('agentPolicy.repoAccess')}<select value={trustMode} disabled={busy}
        onChange={(event) => { setTrustMode(event.target.value); void saveTrust(event.target.value); }}>
        <option value="">{t('agentPolicy.chooseAccess')}</option>
        <option value="read-only">{t('agentPolicy.readOnly')}</option>
        <option value="workspace">{t('agentPolicy.workspace')}</option>
      </select></label>
      {groupFeedback('trust')}
    </div>}
    <div className="v2-agent-policy__group">
      <h3>{t('agentPolicy.memory')}</h3>
      {documents ? <>
        <div className="v2-agent-policy__memory-tabs" role="tablist" aria-label={t('agentPolicy.memory')}>
          {memorySections.map((entry) => <button type="button" role="tab" aria-selected={entry === section}
            key={entry} onClick={() => changeSection(entry)}>{t(`agentPolicy.section.${entry}`)}</button>)}
        </div>
        <label>{t(`agentPolicy.section.${section}`)}<textarea value={content} rows={8}
          onChange={(event) => setContent(event.target.value)} /></label>
        <button type="button" disabled={busy || content === documents[section].content} onClick={saveMemory}>{t('agentPolicy.saveMemory')}</button>
      </> : memoryLoadError ? <>
        <p role="alert" className="v2-agent-policy__error">{memoryLoadError}</p>
        <button type="button" onClick={() => { setMemoryLoadError(null);
          void loadMemory().catch((requestError) => setMemoryLoadError(message(requestError, t('agentPolicy.loadError'))));
        }}>{t('agentPolicy.retry')}</button>
      </> : <p className="v2-agent-policy__muted">{t('agentPolicy.loadingMemory')}</p>}
      {groupFeedback('memory')}
    </div>
    {(installation?.runtime?.runtimeType === 'hosted' || installation?.runtime?.runtimeType === 'native') && (
      <div className="v2-agent-policy__group">
        <h3>{t('agentPolicy.quotas')}</h3>
        <div className="v2-agent-policy__quota"><span>{t('agentPolicy.turnsPerDay')}</span><strong>{quota?.turnCap ?? '—'}</strong></div>
        <div className="v2-agent-policy__quota"><span>{t('agentPolicy.userRunCeiling')}</span><strong>{quota?.userRunCeiling ?? '—'}</strong></div>
        {quotaError && <p role="alert" className="v2-agent-policy__error">{quotaError}</p>}
      </div>
    )}
  </section>;
};

export default V2AgentPolicy;
