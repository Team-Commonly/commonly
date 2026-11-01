import React, { useCallback, useEffect, useState } from 'react';
import axios from '../../utils/axiosConfig';
import './V2DevicesPanel.css';

interface Device {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface V2DevicesPanelProps {
  showHeading?: boolean;
  /** Settings row: a one-line summary that expands to the list (D215, TASK-688). */
  asFold?: boolean;
}

const dateLabel = (value: string | null) => (value ? new Date(value).toLocaleString() : 'Never');

const V2DevicesPanel: React.FC<V2DevicesPanelProps> = ({ showHeading = true, asFold = false }) => {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const response = await axios.get<{ devices: Device[] }>('/api/auth/devices');
      setDevices(response.data.devices);
      setError(null);
    } catch {
      setError('Couldn’t load your devices.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const revoke = async (device: Device) => {
    if (!window.confirm(`Revoke ${device.label}? This CLI will need to sign in again.`)) return;
    try {
      await axios.delete(`/api/auth/devices/${device.id}`);
      setDevices((current) => current.map((entry) => entry.id === device.id ? { ...entry, revokedAt: new Date().toISOString() } : entry));
    } catch {
      setError('Couldn’t revoke that device.');
    }
  };

  if (asFold) {
    const live = devices.filter((device) => !device.revokedAt);
    const lastUsed = live.map((device) => device.lastUsedAt).filter(Boolean).sort().pop();
    const summary = loading ? 'Loading…' : error ? 'Couldn’t load' : live.length === 0 ? 'None'
      : `${live.length} CLI device${live.length === 1 ? '' : 's'}${lastUsed ? ` · used ${new Date(lastUsed as string).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}`;
    return (
      <details className="v2-settings__fold">
        <summary className="v2-settings__row v2-settings__summary">
          <svg className="v2-settings__icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 6h16v10H4zM2 20h20" /></svg>
          <span className="v2-settings__row-label">Devices</span>
          <span className="v2-settings__row-value">{summary}</span>
          <svg className="v2-settings__icon v2-settings__chev" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
        </summary>
        <div className="v2-settings__fold-body">{renderPanel()}</div>
      </details>
    );
  }

  return renderPanel();

  function renderPanel() {
    return (
    <section className="v2-devices" aria-labelledby="devices-heading">
      <div className="v2-devices__heading"><div>{showHeading && <h2 id="devices-heading">Devices</h2>}<p>CLI device tokens are long-lived until you revoke them.</p></div><button type="button" onClick={() => void load()} disabled={loading}>Refresh</button></div>
      {error && <p className="v2-devices__error">{error}</p>}
      {loading && <p>Loading devices…</p>}
      {!loading && devices.length === 0 && <p className="v2-devices__empty">No CLI devices are connected.</p>}
      {!loading && devices.length > 0 && <div className="v2-devices__list">
        {devices.map((device) => <article className="v2-devices__item" key={device.id}>
          <div><strong>{device.label}</strong><span>Created {dateLabel(device.createdAt)} · Last used {dateLabel(device.lastUsedAt)}</span></div>
          {device.revokedAt ? <span className="v2-devices__revoked">Revoked {dateLabel(device.revokedAt)}</span> : <button type="button" onClick={() => void revoke(device)}>Revoke</button>}
        </article>)}
      </div>}
    </section>
    );
  }
};

export default V2DevicesPanel;
