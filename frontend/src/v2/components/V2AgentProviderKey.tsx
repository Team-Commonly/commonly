import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useV2Api } from '../hooks/useV2Api';
import V2AgentSettingsIcon from '../agents/V2AgentSettingsIcon';
interface Metadata { set: boolean; setAt: string | null; setBy: string | null; lastUsedAt: string | null }
const V2AgentProviderKey: React.FC<{ name: string; instanceId: string; editable: boolean;
  capability?: { available: boolean; provider: string | null }; harness: string }> = ({ name, instanceId, editable, capability, harness }) => {
  const api = useV2Api();
  const { t } = useTranslation();
  const k = (key: string, values?: Record<string, string>) => t(`agentManage.providerKey.${key}`, values);
  const url = `/api/registry/agents/${encodeURIComponent(name)}/provider-key?instanceId=${encodeURIComponent(instanceId)}`;
  const [metadata, setMetadata] = useState<Metadata | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setDraft(''); setEditing(false); setMetadata(null); setError('');
    if (editable) void api.get<Metadata>(url).then((next) => { if (active) setMetadata(next); })
      .catch(() => { if (active) setError(k('loadError')); });
    return () => { active = false; };
  }, [api, url, editable]);
  const save = async () => {
    const material = draft;
    // Clear the input before the request, including all failure paths. Never
    // echo an API response body here: even a proxy failure may contain input.
    setDraft(''); setBusy(true); setError('');
    try { setMetadata(await api.put<Metadata>(url, { key: material })); setEditing(false); }
    catch { setError(k('saveError')); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setError(''); setDraft('');
    try { setMetadata(await api.del<Metadata>(url)); setEditing(false); }
    catch { setError(k('saveError')); }
    finally { setBusy(false); }
  };
  const alert = error && <span role="alert" className="v2-agent-settings-page__note"><V2AgentSettingsIcon name="alert" />{error}</span>;
  const canEdit = editable && capability?.available;
  return <>
    <h3 className="gtitle"><V2AgentSettingsIcon name="key" />{k('title')}</h3>
    <div className="list">
      {canEdit && editing ? <form className="v2-agent-settings-page__keyentry" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label className="mu" htmlFor="own-provider-key">{k('input')}</label>
        <span className="field">
          <input id="own-provider-key" type="password" autoComplete="new-password" value={draft} disabled={busy} onChange={(event) => setDraft(event.target.value)} />
        </span>
        {alert}
        <span className="v2-agent-settings-page__actions">
          <button className="b b-p" type="submit" disabled={busy || !draft.trim()}>{k('save')}</button>
          <button className="b b-g" type="button" disabled={busy} onClick={() => { setDraft(''); setEditing(false); }}>{k('cancel')}</button>
        </span>
      </form> : canEdit ? <div className="lrow v2-agent-settings-page__stack">
        <span className="lb"><V2AgentSettingsIcon name="lock" />{k('provider', { provider: capability?.provider || '' })}</span>
        <span className="vl">
          {metadata?.set && <><span className="dot" aria-hidden="true" />{k('set')} · {metadata.setAt ? new Date(metadata.setAt).toLocaleString() : ''}<span className="mo">{k('neverShown')}</span></>}
          {alert}
        </span>
        <span className="ac">
          <button className="b b-s b-sm" type="button" disabled={busy || !metadata} onClick={() => setEditing(true)}>{metadata?.set ? k('replace') : k('setAction')}</button>
          {metadata?.set && <button className="b b-g b-sm" type="button" disabled={busy} onClick={() => { void remove(); }}>{k('remove')}</button>}
        </span>
      </div> : <div className="lrow v2-agent-settings-page__plain">
        <span className="lb">{!editable ? k('readOnly') : k('unavailable', { harness })}</span>
        <span className="vl">{alert}</span>
        <span className="ac">
          {editable && metadata?.set && <button className="b b-g b-sm" type="button" disabled={busy} onClick={() => { void remove(); }}>{k('remove')}</button>}
        </span>
      </div>}
    </div>
  </>;
};
export default V2AgentProviderKey;
