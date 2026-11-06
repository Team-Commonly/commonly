import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import axios from '../../utils/axiosConfig';
import V2AgentSettingsIcon from './V2AgentSettingsIcon';
import { hostedCapNotice } from '../components/hostedCapNotice';
import { InstallNarrowing, V2InstallNarrowingNotice, installNarrowingFromError } from '../components/V2OutsiderGrantNarrowing';

interface Pod { _id: string; name: string; type?: string; publicRead?: boolean }

// Personal pods refuse a third party. A public pod is never offered, for the
// same reason as the Bring your own picker: strangers can reach the agent there.
const PERSONAL_POD_TYPES = ['agent-room', 'agent-dm', 'agent-admin'];

interface Props {
  agentName: string;
  displayName: string;
  query: string;
  installedPodIds: string[];
  onAdded: (podName: string) => void;
}

// The Wake list's footer. The server copies the agent's config from the
// owner's own row, so a pod is the only thing this asks for.
const V2AgentAddToPod: React.FC<Props> = ({ agentName, displayName, query, installedPodIds, onAdded }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [pods, setPods] = useState<Pod[] | null>(null);
  const [podId, setPodId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [narrowing, setNarrowing] = useState<InstallNarrowing | null>(null);

  const close = () => {
    setOpen(false);
    setError(null);
    setNarrowing(null);
  };

  const start = async () => {
    setOpen(true);
    setPods(null);
    setError(null);
    try {
      const { data } = await axios.get<Pod[]>('/api/pods');
      const options = (Array.isArray(data) ? data : []).filter((pod) => !PERSONAL_POD_TYPES.includes(pod.type || '')
        && !pod.publicRead && !installedPodIds.includes(pod._id));
      setPods(options);
      setPodId(options[0]?._id || '');
    } catch {
      setPods([]);
      setError(t('agentSettings.addToPod.loadError'));
    }
  };

  const add = async (confirmNarrowing = false) => {
    const pod = pods?.find((row) => row._id === podId);
    if (!pod) return;
    setBusy(true);
    setError(null);
    setNarrowing(null);
    try {
      await axios.post(
        `/api/registry/agents/${encodeURIComponent(agentName)}/pods/${encodeURIComponent(pod._id)}?${query}`,
        confirmNarrowing ? { confirmNarrowing: true } : {},
      );
      close();
      onAdded(pod.name);
    } catch (requestError) {
      const response = (requestError as { response?: { data?: { code?: string; status?: string; cap?: number; holders?: Array<{ agentName?: string; displayName?: string }> } } }).response;
      const code = response?.data?.code;
      const refused = installNarrowingFromError(requestError);
      if (refused) setNarrowing(refused);
      // A second click lands here after the first one worked. A row that isn't
      // active lands here too, and that one wasn't added.
      else if (code === 'agent_already_in_pod' && (response?.data?.status || 'active') === 'active') { close(); onAdded(pod.name); }
      else if (code === 'agent_already_in_pod') setError(t('agentSettings.addToPod.inactive', { pod: pod.name }));
      else if (code === 'hosted_cap_reached') setError(hostedCapNotice(t, response?.data));
      else if (code === 'not_agent_owner') setError(t('agentSettings.addToPod.notOwner'));
      else setError(t('agentSettings.addToPod.error', { name: displayName }));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="v2-agent-wake-pods__add">
        <button type="button" className="b b-g b-sm" onClick={() => { void start(); }}>
          <V2AgentSettingsIcon name="plus" />{t('agentSettings.addToPod.action')}
        </button>
      </div>
    );
  }

  return (
    <div className="v2-agent-wake-pods__add">
      {pods === null && <span className="mu" role="status">{t('agentSettings.addToPod.loading')}</span>}
      {pods !== null && pods.length === 0 && !error && <span className="mu">{t('agentSettings.addToPod.none')}</span>}
      {pods !== null && pods.length > 0 && !narrowing && <>
        <label className="sel v2-agent-wake-pods__interval">
          <span className="v2-agent-wake-pods__sr">{t('agentSettings.addToPod.choose')}</span>
          <select value={podId} disabled={busy} onChange={(event) => setPodId(event.target.value)}>
            {pods.map((pod) => <option key={pod._id} value={pod._id}>{pod.name}</option>)}
          </select>
          <V2AgentSettingsIcon name="chev" />
        </label>
        <button type="button" className="b b-p b-sm" disabled={busy || !podId} onClick={() => { void add(); }}>
          {t('agentSettings.addToPod.add')}
        </button>
      </>}
      {narrowing && <V2InstallNarrowingNotice agentName={displayName} narrowing={narrowing} busy={busy}
        confirmLabel={t('agentSettings.addToPod.addAnyway')} confirmClassName="b b-p b-sm" cancelClassName="b b-g b-sm"
        onConfirm={() => { void add(true); }} onCancel={() => setNarrowing(null)} />}
      {!narrowing && <button type="button" className="b b-g b-sm" disabled={busy} onClick={close}>{t('agentSettings.addToPod.cancel')}</button>}
      {error && <p className="v2-agent-wake-pods__error" role="alert">{error}</p>}
    </div>
  );
};

export default V2AgentAddToPod;
