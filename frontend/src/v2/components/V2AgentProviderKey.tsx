import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useV2Api } from '../hooks/useV2Api';
import { formatAgentTimestamp } from '../agents/formatAgentTimestamp';
interface Metadata { set: boolean; setAt: string | null; setBy: string | null; lastUsedAt: string | null }
const V2AgentProviderKey: React.FC<{ name: string; instanceId: string; editable: boolean;
  capability?: { available: boolean; provider: string | null }; harness: string }> = ({ name, instanceId, editable, capability, harness }) => {
  const api = useV2Api();
  const { t, i18n } = useTranslation();
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
  return <div className="v2-runtime-controls__key">
    <h3>{k('title')}</h3>
    <p className="v2-runtime-controls__meta">{!editable ? k('readOnly')
      : !capability?.available ? k('unavailable', { harness }) : k('provider', { provider: capability.provider || '' })}</p>
    {editable && metadata?.set && <p className="v2-runtime-controls__meta">{k('set')} · {metadata.setAt ? formatAgentTimestamp(metadata.setAt, i18n.language) : ''}</p>}
    {editable && capability?.available && (editing ? <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label htmlFor="own-provider-key">{k('input')}</label>
      <input id="own-provider-key" type="password" autoComplete="new-password" value={draft} disabled={busy} onChange={(event) => setDraft(event.target.value)} />
      <button className="v2-runtime-controls__save" type="submit" disabled={busy || !draft.trim()}>{k('save')}</button>
      <button type="button" disabled={busy} onClick={() => { setDraft(''); setEditing(false); }}>{k('cancel')}</button>
    </form> : <button className="v2-runtime-controls__save" type="button" disabled={busy || !metadata} onClick={() => setEditing(true)}>{metadata?.set ? k('replace') : k('setAction')}</button>)}
    {editable && metadata?.set && <button className="v2-runtime-controls__remove" type="button" disabled={busy} onClick={() => { void remove(); }}>{k('remove')}</button>}
    {error && <p role="alert">{error}</p>}
  </div>;
};
export default V2AgentProviderKey;
