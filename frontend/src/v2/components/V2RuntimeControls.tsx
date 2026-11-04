import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import V2AgentSettingsIcon from '../agents/V2AgentSettingsIcon';
import { appDateLocale } from '../utils/appLocale';
import {
  FALLBACK_HARNESSES, HarnessCatalogEntry, OTHER_MODEL, effortLevelsFor, harnessDeviceNote, harnessLabel, modelChoicesFor,
  orderHarnessIds,
} from '../utils/harnessCatalog';

export interface RuntimeReceipt { harness: string; version: string | null; model: string | null; effort: string | null; at: string; durationMs?: number | null }
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
  catalog?: HarnessCatalogEntry[];
}
export type RuntimeUpdate = { adapter?: string; model?: string; effort?: string };
const canonical = (value?: string) => value === 'claude-code' ? 'claude' : value || '';
const V2RuntimeControls: React.FC<{ runtime: RuntimeSettings; onSave?: (update: RuntimeUpdate) => Promise<void> }> = ({ runtime, onSave }) => {
  const { t } = useTranslation();
  const k = (key: string, values?: Record<string, string>) => t(`agentManage.controls.${key}`, values);
  const savedHarness = canonical(runtime.adapter || runtime.runtimeType);
  const [harness, setHarness] = useState(savedHarness);
  const [model, setModel] = useState(runtime.model || '');
  const [effort, setEffort] = useState(runtime.effort || '');
  // "Other…" in the model list: the person types a full id the list lacks.
  const [otherModel, setOtherModel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setHarness(savedHarness); }, [savedHarness]);
  useEffect(() => { setModel(runtime.model || ''); setOtherModel(false); }, [runtime.model]);
  useEffect(() => { setEffort(runtime.effort || ''); }, [runtime.effort]);
  // D247: hosted and native turns read their own run config; every other
  // agent the person owns is editable on add and after. Whether this viewer
  // may save is the server's call (runtimeEditable → onSave).
  const hosted = runtime.host === 'cloud' || ['hosted', 'internal', 'native'].includes(runtime.runtimeType || '');
  const editable = Boolean(onSave) && !hosted;
  const catalog = runtime.catalog?.length ? runtime.catalog : FALLBACK_HARNESSES;
  const label = (id: string) => harnessLabel(catalog, id);
  const inventory = runtime.inventory || [];
  const selected = inventory.find((row) => row.harness === harness);
  const entry = catalog.find((row) => row.id === harness);
  const levels = effortLevelsFor(entry, selected);
  const choices = modelChoicesFor(entry, selected);
  const models = choices?.models;
  const showEffort = !hosted && levels.length > 0;
  const fields = showEffort ? ['harness', 'model', 'effort'] as const : ['harness', 'model'] as const;
  const harnessIds = orderHarnessIds(catalog, inventory);
  const last = runtime.observation?.lastSpawn;
  const confirmed = runtime.observation?.confirmed;
  // A computer reports only the harnesses it checks; one it said nothing
  // about is not flagged.
  const unsupportedHarness = Boolean(editable && selected && !selected.installed);
  // Only a computer's own list can say a model is unsupported; the catalogue
  // is a starting point, and "Other…" exists for ids it lacks.
  const unsupportedModel = Boolean(editable && choices?.fromDevice && model && !choices.models.includes(model));
  // Save never writes a model the selected harness doesn't list, unless it
  // was typed under "Other…". A stored id that no catalogue lists (an earlier
  // "Other…") stays saveable; one another harness lists (a Codex model left
  // under Claude Code) does not.
  const listedElsewhere = catalog.some((row) => row.id !== harness && row.models?.includes(model));
  const unlistedModel = Boolean(editable && models?.length && model && !models.includes(model) && !otherModel
    && (harness !== savedHarness || model !== (runtime.model || '') || listedElsewhere));
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
    if (field === 'harness') return `${label(receipt.harness)}${receipt.version ? ` ${receipt.version}` : ''}`;
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
  // After a real reply, one quiet line from the spawn receipt. A duration is
  // shown only when the receipt carries one.
  const answeredWith = last ? value(last, 'harness') : '';
  const answered = runtime.observation?.lastSpawnOutcome === 'completed' && last
    ? typeof last.durationMs === 'number' && Number.isFinite(last.durationMs) && last.durationMs >= 0
      ? t('harness.answeredIn', { harness: answeredWith,
        seconds: last.durationMs < 10_000 ? (last.durationMs / 1000).toFixed(1) : String(Math.round(last.durationMs / 1000)) })
      : t('harness.answeredWith', { harness: answeredWith })
    : '';
  const status = runtime.processConnected === true ? k('connected') : runtime.processConnected === false ? k('disconnected') : k('notReported');
  return <>
    {fields.map((field) => <div className="lrow v2-agent-settings-page__stack" key={field}>
      <span className="lb"><V2AgentSettingsIcon name={icons[field]} />
        {pending(field) && <span className="dot" role="img" aria-label={k('pending')} title={k('pending')} />}
        <label htmlFor={`runtime-${field}`}>{k(field)}</label>
      </span>
      <span className="vl">
        <span className="sel v2-runtime-controls__control">
          {field === 'harness' ? <select id="runtime-harness" className={unsupportedHarness ? 'is-unsupported' : ''} disabled={!editable || busy} value={harness} onChange={(event) => {
            // Back to the saved harness restores the saved pair; any other
            // harness starts from its own default, never the last one's model.
            const next = event.target.value;
            const back = next === savedHarness;
            setHarness(next); setOtherModel(false);
            setModel(back ? runtime.model || '' : ''); setEffort(back ? runtime.effort || '' : '');
          }}>
            {!harnessIds.includes(harness) && <option value={harness}>{harness ? label(harness) : k('unknown')}</option>}
            {harnessIds.map((id) => {
              const note = harnessDeviceNote(inventory, id, t);
              const row = inventory.find((item) => item.harness === id);
              return <option key={id} value={id} disabled={Boolean(row && !row.installed)}>{label(id)}{note ? ` · ${note}` : ''}</option>;
            })}
          </select> : field === 'model' ? (models?.length && !otherModel ? <select id="runtime-model" disabled={!editable || busy} value={model} className={unsupportedModel ? 'is-unsupported' : ''} onChange={(event) => {
            if (event.target.value === OTHER_MODEL) { setOtherModel(true); setModel(''); return; }
            setModel(event.target.value);
          }}>
            {(!model || !models.includes(model)) && <option value={model}>{model ? editable ? `${model} · ${k('stored')}` : model : k('default')}</option>}
            {models.map((option) => <option value={option} key={option}>{option}</option>)}
            {editable && !choices?.fromDevice && <option value={OTHER_MODEL}>{t('harness.other')}</option>}
          </select> : <input id="runtime-model" disabled={!editable || busy} value={model} placeholder={otherModel ? t('harness.otherPlaceholder') : undefined} onChange={(event) => setModel(event.target.value)} />)
            : <select id="runtime-effort" disabled={!editable || busy} className={unsupportedEffort ? 'is-unsupported' : ''} value={effort} onChange={(event) => setEffort(event.target.value)}>
              <option value="">{k('default')}</option>
              {editable && storedEffort && <option value={effort}>{effort} · {k('stored')}</option>}
              {!editable && storedEffort && <option value={effort}>{effort}</option>}
              {levels.map((level) => <option key={level} value={level}>{level}</option>)}
            </select>}
          {!(field === 'model' && (!models?.length || otherModel)) && <V2AgentSettingsIcon name="chev" />}
        </span>
        <span className="mo">{k('lastSpawn')} <span>{value(last, field)}</span> · {confirmed ? <>{k('confirmed')} <span>{value(confirmed, field, true)}</span></> : <span>{k('unconfirmed')}</span>}</span>
        {editable && field === 'model' && !models?.length && <span className="mo">{k('modelsUnavailable')}</span>}
      </span>
      <span className="ac" />
    </div>)}
    {unlistedModel && alertRow(k('modelNotListed', { model, harness: label(harness) }))}
    {(unsupportedHarness || unsupportedModel || unsupportedEffort) && alertRow(k('unsupported', { harness: value(last, 'harness'), model: value(last, 'model'), effort: value(last, 'effort') }))}
    {runtime.observation?.lastSpawnOutcome === 'failed' && alertRow(k('spawnFailed', { harness: value(last, 'harness'), model: value(last, 'model'), effort: value(last, 'effort') }))}
    <div className="lrow v2-agent-settings-page__stack v2-runtime-controls__status">
      <span className="lb" />
      <span className="vl mo">
        <span>{editable ? k('nextSpawn')
          : hosted ? k('readOnlyHosted') : k('readOnlyCli')}</span>
        {answered && <span data-testid="runtime-answered">{answered}</span>}
        <span><span>{k('process')}</span> {status}{runtime.processConnected && runtime.observation?.connectedAt ? ` · ${new Date(runtime.observation.connectedAt).toLocaleString(appDateLocale())}` : ''}</span>
        <span><span>{k('turn')}</span> {runtime.processConnected == null ? k('notReported') : runtime.processConnected && runtime.observation?.turnRunning ? k('running') : runtime.observation?.lastTurnAt ? new Date(runtime.observation.lastTurnAt).toLocaleString(appDateLocale()) : k('noTurn')}</span>
        {last && <span>{k('lastSpawn')} · {new Date(last.at).toLocaleString(appDateLocale())}</span>}
      </span>
      <span className="ac">
        {editable && <button type="button" className="b b-p b-sm" aria-label={k('saveRuntime')} disabled={busy || !changed || unsupportedHarness || !model.trim() || unsupportedModel || unlistedModel || Boolean(levels.length && unsupportedEffort)} onClick={() => { void save(); }}>{k('save')}</button>}
        {error && <span role="alert" className="v2-agent-settings-page__note"><V2AgentSettingsIcon name="alert" />{error}</span>}
      </span>
    </div>
  </>;
};
export default V2RuntimeControls;
