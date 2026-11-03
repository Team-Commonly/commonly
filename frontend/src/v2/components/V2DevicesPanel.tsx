import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
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

const V2DevicesPanel: React.FC<V2DevicesPanelProps> = ({ showHeading = true, asFold = false }) => {
  const { i18n, t } = useTranslation();
  const language = i18n.resolvedLanguage || i18n.language || 'en';
  const dateLabel = (value: string | null) => (value ? new Date(value).toLocaleString(language) : t('devices.never'));
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  // Holds a translation key, so the message follows a language switch.
  const [error, setError] = useState<'devices.loadFailed' | 'devices.revokeFailed' | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const response = await axios.get<{ devices: Device[] }>('/api/auth/devices');
      setDevices(response.data.devices);
      setError(null);
    } catch {
      setError('devices.loadFailed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const revoke = async (device: Device) => {
    if (!window.confirm(t('devices.revokeConfirm', { label: device.label }))) return;
    try {
      await axios.delete(`/api/auth/devices/${device.id}`);
      setDevices((current) => current.map((entry) => entry.id === device.id ? { ...entry, revokedAt: new Date().toISOString() } : entry));
    } catch {
      setError('devices.revokeFailed');
    }
  };

  if (asFold) {
    const live = devices.filter((device) => !device.revokedAt);
    const lastUsed = live.map((device) => device.lastUsedAt).filter(Boolean).sort().pop();
    const lastUsedLabel = (value: string) => {
      const when = new Date(value);
      return when.toDateString() === new Date().toDateString()
        ? when.toLocaleTimeString(language, { hour: 'numeric', minute: '2-digit' })
        : when.toLocaleDateString(language, { month: 'short', day: 'numeric' });
    };
    const deviceCount = t('devices.summary.count', { count: live.length });
    const summary = loading ? t('devices.summary.loading') : error ? t('devices.summary.loadFailed') : live.length === 0 ? t('devices.summary.none')
      : lastUsed ? t('devices.summary.lastUsed', { devices: deviceCount, time: lastUsedLabel(lastUsed) }) : deviceCount;
    return (
      <details className="v2p-disc">
        <summary>
          <span className="lb">
            <svg className="v2-settings__icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 6h16v10H4zM2 20h20" /></svg>
            {t('devices.title')}
          </span>
          <span className={error ? 'vl v2-settings__vl--error' : 'vl'}>{summary}</span>
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
      <div className="v2-devices__heading"><div>{showHeading && <h2 id="devices-heading">{t('devices.title')}</h2>}<p>{t('devices.longLived')}</p></div><button type="button" onClick={() => void load()} disabled={loading}>{t('devices.refresh')}</button></div>
      {error && <p className="v2-devices__error">{t(error)}</p>}
      {loading && <p>{t('devices.loading')}</p>}
      {!loading && devices.length === 0 && <p className="v2-devices__empty">{t('devices.empty')}</p>}
      {!loading && devices.length > 0 && <div className="v2-devices__list">
        {devices.map((device) => <article className="v2-devices__item" key={device.id}>
          <div><strong>{device.label}</strong><span>{t('devices.dates', { date: dateLabel(device.createdAt), time: dateLabel(device.lastUsedAt) })}</span></div>
          {device.revokedAt ? <span className="v2-devices__revoked">{t('devices.revokedAt', { date: dateLabel(device.revokedAt) })}</span> : <button type="button" onClick={() => void revoke(device)}>{t('devices.revoke')}</button>}
        </article>)}
      </div>}
    </section>
    );
  }
};

export default V2DevicesPanel;
