import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import './V2RuntimeControls.css';

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
  observation?: RuntimeObservation | null; inventory?: HarnessInventory[]; processConnected?: boolean;
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
  const unsupportedHarness = Boolean(inventory.length && !selected?.installed);
  const unsupportedModel = Boolean(models?.length && model && !models.includes(model));
  const storedEffort = Boolean(effort && !levels.includes(effort));
  const unsupportedEffort = editable && storedEffort;
  const changed = harness !== savedHarness || model !== (runtime.model || '') || effort !== (runtime.effort || '');
  const pending = (field: 'harness' | 'model' | 'effort') => {
    if (!last || (field === 'effort' && !levels.length)) return false;
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
  return <div className="v2-runtime-controls">
    <p className="v2-runtime-controls__meta">{editable ? k('nextSpawn')
      : runtime.host === 'cloud' || ['hosted', 'internal', 'native'].includes(runtime.runtimeType || '') ? k('readOnlyHosted') : k('readOnlyCli')}</p>
    <div className="v2-runtime-controls__table" role="group" aria-label={k('title')}>
      <div className="v2-runtime-controls__head"><span />{['saved', 'lastSpawn', 'confirmed'].map((key) => <span key={key}>{k(key)}</span>)}</div>
      {(['harness', 'model', 'effort'] as const).map((field) => <div className="v2-runtime-controls__row" key={field}>
        <label htmlFor={`runtime-${field}`}>{pending(field) && <span className="v2-runtime-controls__pending" aria-label={k('pending')} />}{k(field)}</label>
        <div className="v2-runtime-controls__saved">
          {field === 'harness' ? <select id="runtime-harness" className={unsupportedHarness ? 'is-unsupported' : ''} disabled={!editable || busy} value={harness} onChange={(event) => { setHarness(event.target.value); setEffort(''); }}>
            {!inventory.some((row) => row.harness === harness) && <option value={harness}>{LABELS[harness] || harness || k('unknown')}</option>}
            {inventory.map((row) => <option key={row.harness} value={row.harness} disabled={!row.installed}>{LABELS[row.harness] || row.harness}{row.version ? ` ${row.version}` : ''}{row.installed ? '' : ` · ${k('notInstalled')}`}</option>)}
          </select> : field === 'model' ? (models?.length ? <select id="runtime-model" disabled={!editable || busy} value={model} className={unsupportedModel ? 'is-unsupported' : ''} onChange={(event) => setModel(event.target.value)}>
            {(!model || unsupportedModel) && <option value={model}>{model ? `${model} · ${k('stored')}` : k('default')}</option>}
            {models.map((option) => <option value={option} key={option}>{option}</option>)}
          </select> : <input id="runtime-model" disabled={!editable || busy} value={model} onChange={(event) => setModel(event.target.value)} />)
            : <select id="runtime-effort" disabled={!editable || busy || !levels.length} className={unsupportedEffort ? 'is-unsupported' : ''} value={effort} onChange={(event) => setEffort(event.target.value)}>
              <option value="">{k('default')}</option>
              {storedEffort && <option value={effort}>{effort} · {k('stored')}</option>}
              {levels.map((level) => <option key={level} value={level}>{level}</option>)}
            </select>}
          {field === 'model' && !models?.length && <small>{k('modelsUnavailable')}</small>}
          {editable && field === 'effort' && !levels.length && effort && <small>{k('effortUnavailable', { harness: LABELS[harness] || harness, effort })}</small>}
        </div>
        <span className="v2-runtime-controls__observed">{value(last, field)}</span>
        <span className="v2-runtime-controls__observed">{value(confirmed, field, true)}</span>
      </div>)}
    </div>
    {(unsupportedHarness || unsupportedModel || unsupportedEffort) && <p className="v2-runtime-controls__refusal">{k('unsupported', { harness: value(last, 'harness'), model: value(last, 'model'), effort: value(last, 'effort') })}</p>}
    {runtime.observation?.lastSpawnOutcome === 'failed' && <p className="v2-runtime-controls__refusal">{k('spawnFailed', { harness: value(last, 'harness'), model: value(last, 'model'), effort: value(last, 'effort') })}</p>}
    {error && <p role="alert">{error}</p>}
    {editable && <button className="v2-runtime-controls__save" aria-label={k('saveRuntime')} disabled={busy || !changed || unsupportedHarness || !model.trim() || unsupportedModel || Boolean(levels.length && unsupportedEffort)} onClick={() => { void save(); }}>{k('save')}</button>}
    <dl className="v2-runtime-controls__status">
      <div><dt>{k('process')}</dt><dd>{runtime.processConnected ? k('connected') : k('disconnected')}{runtime.processConnected && runtime.observation?.connectedAt ? ` · ${new Date(runtime.observation.connectedAt).toLocaleString()}` : ''}</dd></div>
      <div><dt>{k('turn')}</dt><dd>{runtime.processConnected && runtime.observation?.turnRunning ? k('running') : runtime.observation?.lastTurnAt ? new Date(runtime.observation.lastTurnAt).toLocaleString() : k('noTurn')}</dd></div>
    </dl>
    {last && <p className="v2-runtime-controls__meta">{k('lastSpawn')} · {new Date(last.at).toLocaleString()}</p>}
  </div>;
};
export default V2RuntimeControls;
