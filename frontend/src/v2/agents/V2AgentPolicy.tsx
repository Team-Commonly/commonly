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
const commaList = (value: string) => Array.from(new Set(value.split(',').map((item) => item.trim()).filter(Boolean)));
const displayList = (value?: string[]) => (value || []).join(', ');
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
  const policy = installation?.profile?.toolPolicy;
  const context = installation?.profile?.contextPolicy;
  const environment = (installation?.config?.environment || {}) as { adapter?: string; sandbox?: { mode?: string } };
  const runtime = installation?.runtime;
  const adapter = String(environment.adapter || runtime?.adapter || runtime?.runtimeType || '')
    .trim().toLowerCase().replace('claude-code', 'claude');
  const canSetTrust = (runtime?.host === 'byo' || runtime?.runtimeType === 'wrapper')
    && trustAdapters.has(adapter);
  const [allowed, setAllowed] = useState(displayList(policy?.allowed));
  const [blocked, setBlocked] = useState(displayList(policy?.blocked));
  const [approval, setApproval] = useState(displayList(policy?.requireApproval));
  const [maxTokens, setMaxTokens] = useState(context?.maxTokens || 8000);
  const [compactionThreshold, setCompactionThreshold] = useState(context?.compactionThreshold || 6000);
  const [summaryHours, setSummaryHours] = useState(context?.summaryHours || 24);
  const [includeMemory, setIncludeMemory] = useState(context?.includeMemory !== false);
  const [includeSkills, setIncludeSkills] = useState(context?.includeSkills !== false);
  const [includeSummaries, setIncludeSummaries] = useState(context?.includeSummaries !== false);
  const [trustMode, setTrustMode] = useState(environment.sandbox?.mode || '');
  const [quota, setQuota] = useState<{ turnCap: number; userRunCeiling: number | null } | null>(null);
  const [documents, setDocuments] = useState<MemoryDocuments | null>(null);
  const [section, setSection] = useState<MemorySection>('long_term');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ group: 'policy' | 'trust' | 'memory';
    kind: 'error' | 'saved'; text: string } | null>(null);
  const [memoryLoadError, setMemoryLoadError] = useState<string | null>(null);
  const [quotaError, setQuotaError] = useState<string | null>(null);

  useEffect(() => {
    setAllowed(displayList(policy?.allowed));
    setBlocked(displayList(policy?.blocked));
    setApproval(displayList(policy?.requireApproval));
    setMaxTokens(context?.maxTokens || 8000);
    setCompactionThreshold(context?.compactionThreshold || 6000);
    setSummaryHours(context?.summaryHours || 24);
    setIncludeMemory(context?.includeMemory !== false);
    setIncludeSkills(context?.includeSkills !== false);
    setIncludeSummaries(context?.includeSummaries !== false);
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

  const savePolicy = async () => {
    if (!installation?.profile) {
      setFeedback({ group: 'policy', kind: 'error', text: t('agentPolicy.profileUnavailableSave') }); return;
    }
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || !Number.isInteger(compactionThreshold)
      || compactionThreshold < 1 || compactionThreshold > maxTokens
      || !Number.isInteger(summaryHours) || summaryHours < 1) {
      setFeedback({ group: 'policy', kind: 'error', text: t('agentPolicy.contextInvalid') }); return;
    }
    setBusy(true); setFeedback(null);
    try {
      await update({ toolPolicy: { allowed: commaList(allowed), blocked: commaList(blocked),
        requireApproval: commaList(approval) },
      contextPolicy: { maxTokens, compactionThreshold, summaryHours,
        includeMemory, includeSkills, includeSummaries } });
      setFeedback({ group: 'policy', kind: 'saved', text: t('agentPolicy.saved') });
    } catch (requestError) { setFeedback({ group: 'policy', kind: 'error', text: message(requestError, t('agentPolicy.saveError')) }); }
    finally { setBusy(false); }
  };

  const saveTrust = async () => {
    if (!canSetTrust || !['read-only', 'workspace'].includes(trustMode)) return;
    setBusy(true); setFeedback(null);
    try {
      await update({ config: { environment: { sandbox: { mode: trustMode } } } });
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

  const groupFeedback = (group: 'policy' | 'trust' | 'memory') => feedback?.group === group && (
    <p role={feedback.kind === 'error' ? 'alert' : 'status'}
      className={feedback.kind === 'error' ? 'v2-agent-policy__error' : 'v2-agent-policy__saved'}>{feedback.text}</p>
  );

  return <section className="v2-agent-policy" aria-labelledby="agent-policy-title">
    <h2 id="agent-policy-title">{t('agentPolicy.title')}</h2>
    {!installation?.profile && feedback?.group !== 'policy' && (
      <p role="alert" className="v2-agent-policy__error">{t('agentPolicy.profileUnavailable')}</p>
    )}
    <div className="v2-agent-policy__group">
      <h3>{t('agentPolicy.approvals')}</h3>
      <p className="v2-agent-policy__muted">{t('agentPolicy.commaHint')}</p>
      <label>{t('agentPolicy.allowed')}<input value={allowed} onChange={(event) => setAllowed(event.target.value)} /></label>
      <label>{t('agentPolicy.blocked')}<input value={blocked} onChange={(event) => setBlocked(event.target.value)} /></label>
      <label>{t('agentPolicy.requireApproval')}<input value={approval} onChange={(event) => setApproval(event.target.value)} /></label>
    </div>
    <div className="v2-agent-policy__group">
      <h3>{t('agentPolicy.context')}</h3>
      <div className="v2-agent-policy__numbers">
        <label>{t('agentPolicy.maxTokens')}<input type="number" min="1" value={maxTokens} onChange={(event) => setMaxTokens(Number(event.target.value))} /></label>
        <label>{t('agentPolicy.compactionThreshold')}<input type="number" min="1" max={maxTokens} value={compactionThreshold} onChange={(event) => setCompactionThreshold(Number(event.target.value))} /></label>
        <label>{t('agentPolicy.summaryHours')}<input type="number" min="1" value={summaryHours} onChange={(event) => setSummaryHours(Number(event.target.value))} /></label>
      </div>
      <div className="v2-agent-policy__checks">
        <label><input type="checkbox" checked={includeMemory} onChange={(event) => setIncludeMemory(event.target.checked)} />{t('agentPolicy.includeMemory')}</label>
        <label><input type="checkbox" checked={includeSkills} onChange={(event) => setIncludeSkills(event.target.checked)} />{t('agentPolicy.includeSkills')}</label>
        <label><input type="checkbox" checked={includeSummaries} onChange={(event) => setIncludeSummaries(event.target.checked)} />{t('agentPolicy.includeSummaries')}</label>
      </div>
      <button type="button" disabled={busy} onClick={savePolicy}>{t('agentPolicy.savePolicy')}</button>
      {groupFeedback('policy')}
    </div>
    {canSetTrust && <div className="v2-agent-policy__group">
      <h3>{t('agentPolicy.trust')}</h3>
      <label>{t('agentPolicy.repoAccess')}<select value={trustMode} onChange={(event) => setTrustMode(event.target.value)}>
        <option value="">{t('agentPolicy.chooseAccess')}</option>
        <option value="read-only">{t('agentPolicy.readOnly')}</option>
        <option value="workspace">{t('agentPolicy.workspace')}</option>
      </select></label>
      <button type="button" disabled={busy || !['read-only', 'workspace'].includes(trustMode)} onClick={saveTrust}>{t('agentPolicy.saveTrust')}</button>
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
