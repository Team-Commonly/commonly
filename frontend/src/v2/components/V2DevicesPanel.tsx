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
}

const dateLabel = (value: string | null) => (value ? new Date(value).toLocaleString() : 'Never');

const V2DevicesPanel: React.FC<V2DevicesPanelProps> = ({ showHeading = true }) => {
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

  return (
    <section className="v2-devices" aria-labelledby="devices-heading">
      <div className="v2-devices__heading"><div>{showHeading && <h2 id="devices-heading">Devices</h2>}<p>CLI device tokens are long-lived until you revoke them.</p></div><button type="button" onClick={() => void load()} disabled={loading}>Refresh</button></div>
      {error && <p className="v2-devices__error">{error}</p>}
      {loading && <p>Loading devices…</p>}
      {!loading && devices.length === 0 && <p className="v2-devices__empty">No CLI devices are connected.</p>}
      {!loading && devices.length > 0 && <div className="v2-devices__list">
        {devices.map((device) => <article className="v2-devices__item" key={device.id}>
          <div><strong>{device.label}</strong><span>Created {dateLabel(device.createdAt)} · Last used {dateLabel(device.lastUsedAt)}</span></div>
          {device.revokedAt ? <span className="v2-devices__revoked">Revoked</span> : <button type="button" onClick={() => void revoke(device)}>Revoke</button>}
        </article>)}
      </div>}
    </section>
  );
};

export default V2DevicesPanel;
