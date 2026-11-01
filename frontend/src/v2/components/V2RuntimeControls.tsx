import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import V2AgentSettingsIcon from '../agents/V2AgentSettingsIcon';

export interface RuntimeReceipt { harness: string; version: string | null; model: string | null; effort: string | null; at: string }
export interface RuntimeObservation {
  connectedAt: string; lastSeenAt: string; turnRunning: boolean; lastTurnAt: string | null;
  lastSpawnOutcome?: 'completed' | 'failed' | null;
  lastSpawn: RuntimeReceipt | null; confirmed: RuntimeReceipt | null;
}
export interface HarnessInventory { harness: string; installed: boolean; version: string | null; models: string[] | null; efforts: string[] }
export interface RuntimeSettings {
  providerId?: string; runtimeType?: string; host?: 'cloud' | 'byo'; adapter?: string; model?: string; effort?: string; managed?: boolean;
  ownKeyCapability?: { available: boolean; provider: string | null };
  observation?: RuntimeObservation | null; inventory?: HarnessInventory[]; processConnected?: boolean | null;
}
export type RuntimeUpdate = { adapter?: string; model?: string; effort?: string };
const LABELS: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', hermes: 'Hermes', dsh: 'DeepSeek Harness' };
const canonical = (value?: string) => value === 'claude-code' ? 'claude' : value || '';
const V2RuntimeControls: React.FC<{ runtime: RuntimeSettings; onSave?: (update: RuntimeUpdate) => Promise<void> }> = ({ runtime, onSave }) => {
  const { t } = useTranslation();
  const k = (key: string, values?: Record<string, string>) => t(`agentManage.controls.${key}`, values);
  const savedHarness = canonical(runtime.adapter || runtime.runtimeType);
  const [harness, setHarness] = useState(savedHarness);
  const [model, setModel] = useState(runtime.model || '');
  const [effort, setEffort] = useState(runtime.effort || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setHarness(savedHarness); }, [savedHarness]);
  useEffect(() => { setModel(runtime.model || ''); }, [runtime.model]);
  useEffect(() => { setEffort(runtime.effort || ''); }, [runtime.effort]);
  const editable = Boolean(onSave && runtime.managed !== false && runtime.runtimeType === 'wrapper');
  const inventory = runtime.inventory || [];
  const selected = inventory.find((row) => row.harness === harness);
  const levels = selected?.efforts || [];
  const models = selected?.models;
  const last = runtime.observation?.lastSpawn;
  const confirmed = runtime.observation?.confirmed;
  const unsupportedHarness = Boolean(editable && inventory.length && !selected?.installed);
  const unsupportedModel = Boolean(editable && models?.length && model && !models.includes(model));
  const storedEffort = Boolean(effort && !levels.includes(effort));
  const unsupportedEffort = editable && storedEffort && levels.length > 0;
  const changed = harness !== savedHarness || model !== (runtime.model || '') || effort !== (runtime.effort || '');
  const pending = (field: 'harness' | 'model' | 'effort') => {
    if (!last || (field === 'effort' && (!levels.length || (runtime.effort && !levels.includes(runtime.effort))))) return false;
    let desired = field === 'harness' ? savedHarness : runtime[field] || null;
    // OpenCode's native argument qualifies the configured upstream model with
    // the explicitly declared provider. That spelling alone is not a change.
    if (field === 'model' && savedHarness === 'opencode' && runtime.providerId && desired) {
      desired = `${runtime.providerId}/${desired}`;
    }
    return desired !== last[field];
  };
  const value = (receipt: RuntimeReceipt | null | undefined, field: 'harness' | 'model' | 'effort', confirmation = false) => {
    if (!receipt) return k(confirmation ? 'unconfirmed' : 'notReported');
    if (field === 'harness') return `${LABELS[receipt.harness] || receipt.harness}${receipt.version ? ` ${receipt.version}` : ''}`;
    return receipt[field] || k('default');
  };
  const save = async () => {
    if (!onSave) return;
    setBusy(true); setError('');
    try {
      await onSave({ adapter: harness,
        ...(model !== (runtime.model || '') ? { model: model.trim() } : {}),
        ...(effort !== (runtime.effort || '') ? { effort } : {}) });
    } catch (failure) {
      setError((failure as { response?: { data?: { error?: string } } })?.response?.data?.error || k('saveError'));
    } finally { setBusy(false); }
  };
  const icons = { harness: 'cpu', model: 'brain', effort: 'bolt' } as const;
  const alertRow = (text: string) => <div className="lrow v2-agent-settings-page__alert">
    <span className="lb"><V2AgentSettingsIcon name="alert" />{text}</span>
  </div>;
  const status = runtime.processConnected === true ? k('connected') : runtime.processConnected === false ? k('disconnected') : k('notReported');
  return <>
    {(['harness', 'model', 'effort'] as const).map((field) => <div className="lrow v2-agent-settings-page__stack" key={field}>
      <span className="lb"><V2AgentSettingsIcon name={icons[field]} />
        {pending(field) && <span className="dot" role="img" aria-label={k('pending')} title={k('pending')} />}
        <label htmlFor={`runtime-${field}`}>{k(field)}</label>
      </span>
      <span className="vl">
        <span className="sel v2-runtime-controls__control">
          {field === 'harness' ? <select id="runtime-harness" className={unsupportedHarness ? 'is-unsupported' : ''} disabled={!editable || busy} value={harness} onChange={(event) => { setHarness(event.target.value); setEffort(''); }}>
            {!inventory.some((row) => row.harness === harness) && <option value={harness}>{LABELS[harness] || harness || k('unknown')}</option>}
            {inventory.map((row) => <option key={row.harness} value={row.harness} disabled={!row.installed}>{LABELS[row.harness] || row.harness}{row.version ? ` ${row.version}` : ''}{row.installed ? '' : ` · ${k('notInstalled')}`}</option>)}
          </select> : field === 'model' ? (models?.length ? <select id="runtime-model" disabled={!editable || busy} value={model} className={unsupportedModel ? 'is-unsupported' : ''} onChange={(event) => setModel(event.target.value)}>
            {(!model || !models.includes(model)) && <option value={model}>{model ? editable ? `${model} · ${k('stored')}` : model : k('default')}</option>}
            {models.map((option) => <option value={option} key={option}>{option}</option>)}
          </select> : <input id="runtime-model" disabled={!editable || busy} value={model} onChange={(event) => setModel(event.target.value)} />)
            : <select id="runtime-effort" disabled={!editable || busy || !levels.length} className={unsupportedEffort ? 'is-unsupported' : ''} value={effort} onChange={(event) => setEffort(event.target.value)}>
              <option value="">{k('default')}</option>
              {editable && storedEffort && <option value={effort}>{effort} · {k('stored')}</option>}
              {!editable && storedEffort && <option value={effort}>{effort}</option>}
              {levels.map((level) => <option key={level} value={level}>{level}</option>)}
            </select>}
          {!(field === 'model' && !models?.length) && <V2AgentSettingsIcon name="chev" />}
        </span>
        <span className="mo">{k('lastSpawn')} <span>{value(last, field)}</span> · {confirmed ? <>{k('confirmed')} <span>{value(confirmed, field, true)}</span></> : <span>{k('unconfirmed')}</span>}</span>
        {editable && field === 'model' && !models?.length && <span className="mo">{k('modelsUnavailable')}</span>}
        {editable && field === 'effort' && !levels.length && effort && <span className="mo">{k('effortUnavailable', { harness: LABELS[harness] || harness, effort })}</span>}
      </span>
      <span className="ac" />
    </div>)}
    {(unsupportedHarness || unsupportedModel || unsupportedEffort) && alertRow(k('unsupported', { harness: value(last, 'harness'), model: value(last, 'model'), effort: value(last, 'effort') }))}
    {runtime.observation?.lastSpawnOutcome === 'failed' && alertRow(k('spawnFailed', { harness: value(last, 'harness'), model: value(last, 'model'), effort: value(last, 'effort') }))}
    <div className="lrow v2-agent-settings-page__stack v2-runtime-controls__status">
      <span className="lb" />
      <span className="vl mo">
        <span>{editable ? k('nextSpawn')
          : runtime.host === 'cloud' || ['hosted', 'internal', 'native'].includes(runtime.runtimeType || '') ? k('readOnlyHosted') : k('readOnlyCli')}</span>
        <span><span>{k('process')}</span> {status}{runtime.processConnected && runtime.observation?.connectedAt ? ` · ${new Date(runtime.observation.connectedAt).toLocaleString()}` : ''}</span>
        <span><span>{k('turn')}</span> {runtime.processConnected == null ? k('notReported') : runtime.processConnected && runtime.observation?.turnRunning ? k('running') : runtime.observation?.lastTurnAt ? new Date(runtime.observation.lastTurnAt).toLocaleString() : k('noTurn')}</span>
        {last && <span>{k('lastSpawn')} · {new Date(last.at).toLocaleString()}</span>}
      </span>
      <span className="ac">
        {editable && <button type="button" className="b b-p b-sm" aria-label={k('saveRuntime')} disabled={busy || !changed || unsupportedHarness || !model.trim() || unsupportedModel || Boolean(levels.length && unsupportedEffort)} onClick={() => { void save(); }}>{k('save')}</button>}
        {error && <span role="alert" className="v2-agent-settings-page__note"><V2AgentSettingsIcon name="alert" />{error}</span>}
      </span>
    </div>
  </>;
};
export default V2RuntimeControls;
