import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import axios from '../../utils/axiosConfig';
import type { AgentSettingsInstallation, AgentSettingsPatch } from './useAgentSettings';
import V2AgentSettingsIcon from './V2AgentSettingsIcon';
import './v2-agent-policy.css';

type MemorySection = 'soul' | 'long_term' | 'shared';
type MemoryDocument = { content: string; updatedAt: string | null; visibility: string };
type MemoryDocuments = Record<MemorySection, MemoryDocument>;
const memorySections: MemorySection[] = ['long_term', 'soul', 'shared'];
const trustAdapters = new Set(['claude', 'codex', 'opencode', 'qwen']);
// A 403 is an answer, not a failure: the viewer can't edit this memory, and a retry won't change that.
const forbidden = (error: unknown): boolean => (error as { response?: { status?: number } })?.response?.status === 403;

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
  const [memoryPrivate, setMemoryPrivate] = useState(false);
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
    setMemoryPrivate(false);
    setQuotaError(null);
    void axios.get<{ sections: MemoryDocuments }>(memoryUrl).then((response) => {
      if (current) {
        setDocuments(response.data.sections);
        setContent(response.data.sections.long_term?.content || '');
      }
    }).catch((requestError) => {
      if (!current) return;
      if (forbidden(requestError)) setMemoryPrivate(true);
      else setMemoryLoadError(message(requestError, t('agentPolicy.loadError')));
    });
    void axios.get<{ turnCap: number; userRunCeiling: number | null }>(
      `/api/registry/agents/${encodeURIComponent(agentName)}/manage-settings`, { params: { instanceId } },
    ).then((response) => { if (current) setQuota(response.data); })
      .catch((requestError) => { if (current) setQuotaError(message(requestError, t('agentPolicy.loadError'))); });
    return () => { current = false; };
  }, [agentName, instanceId, memoryUrl, t]);

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

  // The trust row's check and "Saved" stand in the action slot for a moment, then the slot is the button alone again.
  // The memory editor's "Saved" stays until the next action.
  useEffect(() => {
    if (feedback?.kind !== 'saved' || feedback.group !== 'trust') return undefined;
    const timer = window.setTimeout(() => setFeedback((current) => (current === feedback ? null : current)), 2500);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const groupFeedback = (group: 'trust' | 'memory') => feedback?.group === group && (
    <p role={feedback.kind === 'error' ? 'alert' : 'status'}
      className={feedback.kind === 'error' ? 'v2-agent-policy__error' : 'v2-agent-policy__saved'}>{feedback.text}</p>
  );
  const trustFeedback = feedback?.group === 'trust' && (
    <span role={feedback.kind === 'error' ? 'alert' : 'status'} className="v2-agent-settings-page__note">
      <V2AgentSettingsIcon name={feedback.kind === 'error' ? 'alert' : 'check'} />{feedback.text}
    </span>
  );
  const hasQuota = installation?.runtime?.runtimeType === 'hosted' || installation?.runtime?.runtimeType === 'native';

  // Lives in the How it runs disclosure; the section is named, not headed.
  return <section className="v2-agent-settings-page__policy" aria-label={t('agentPolicy.title')}>
    {(canSetTrust || hasQuota) && <div className="list">
      {canSetTrust && <div className="lrow v2-agent-settings-page__stack">
        <span className="lb" id="agent-policy-trust"><V2AgentSettingsIcon name="lock" />{t('agentPolicy.repoAccess')}</span>
        <span className="vl">
          <span className="seg seg--sm" role="radiogroup" aria-labelledby="agent-policy-trust">
            {(['read-only', 'workspace'] as const).map((mode) => <label key={mode}>
              <input type="radio" name="agent-policy-trust" value={mode} checked={trustMode === mode}
                onChange={() => setTrustMode(mode)} />
              {t(mode === 'read-only' ? 'agentPolicy.readOnly' : 'agentPolicy.workspace')}
            </label>)}
          </span>
        </span>
        <span className="ac">
          <button type="button" className="b b-p b-sm" disabled={busy || !['read-only', 'workspace'].includes(trustMode)} onClick={saveTrust}>{t('agentPolicy.saveTrust')}</button>
          {trustFeedback}
        </span>
      </div>}
      {hasQuota && <>
        <div className="lrow">
          <span className="lb"><V2AgentSettingsIcon name="bolt" />{t('agentPolicy.turnsPerDay')}</span>
          <span className="vl mo v2-agent-settings-page__figure">{quota?.turnCap ?? '—'}</span>
        </div>
        <div className="lrow">
          <span className="lb"><V2AgentSettingsIcon name="play" />{t('agentPolicy.userRunCeiling')}</span>
          <span className="vl mo v2-agent-settings-page__figure">{quota?.userRunCeiling ?? '—'}</span>
        </div>
        {quotaError && <div className="lrow v2-agent-settings-page__alert">
          <span className="lb" role="alert"><V2AgentSettingsIcon name="alert" />{quotaError}</span>
        </div>}
      </>}
    </div>}
    {/* Memory editing has no frame here yet (the artboard moves it to the Memory tab, which cannot edit yet), so it keeps its live markup. */}
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
      </> : memoryPrivate ? <p className="v2-agent-policy__muted">{t('agentPolicy.memoryPrivate')}</p>
        : memoryLoadError ? <>
        <p role="alert" className="v2-agent-policy__error">{memoryLoadError}</p>
        <button type="button" onClick={() => { setMemoryLoadError(null);
          void loadMemory().catch((requestError) => setMemoryLoadError(message(requestError, t('agentPolicy.loadError'))));
        }}>{t('agentPolicy.retry')}</button>
      </> : <p className="v2-agent-policy__muted">{t('agentPolicy.loadingMemory')}</p>}
      {groupFeedback('memory')}
    </div>
  </section>;
};

export default V2AgentPolicy;
