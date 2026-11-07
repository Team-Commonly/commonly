import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import axios from '../../utils/axiosConfig';
import { useV2Confirm } from '../hooks/useV2Confirm';
import { appDateLocale } from '../utils/appLocale';
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
  const { t } = useTranslation();
  const { confirm, dialog: confirmDialog } = useV2Confirm();
  const dateLabel = (value: string | null) => (
    value ? new Date(value).toLocaleString(appDateLocale()) : t('settings.devices.never')
  );
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
      setError(t('settings.devices.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  const revoke = async (device: Device) => {
    const confirmed = await confirm({
      message: t('settings.devices.revokeConfirm', { label: device.label }),
      confirmLabel: t('settings.devices.revoke'),
    });
    if (!confirmed) return;
    try {
      await axios.delete(`/api/auth/devices/${device.id}`);
      setDevices((current) => current.map((entry) => entry.id === device.id ? { ...entry, revokedAt: new Date().toISOString() } : entry));
    } catch {
      setError(t('settings.devices.revokeFailed'));
    }
  };

  if (asFold) {
    const live = devices.filter((device) => !device.revokedAt);
    const lastUsed = live.map((device) => device.lastUsedAt).filter(Boolean).sort().pop();
    const count = t('settings.devices.count', { count: live.length });
    const usedLabel = (value: string) => {
      const when = new Date(value);
      return when.toDateString() === new Date().toDateString()
        ? when.toLocaleTimeString(appDateLocale(), { hour: 'numeric', minute: '2-digit' })
        : when.toLocaleDateString(appDateLocale(), { month: 'short', day: 'numeric' });
    };
    const summary = loading ? t('settings.devices.loadingShort') : error ? t('settings.devices.loadFailedShort')
      : live.length === 0 ? t('settings.devices.none')
        : lastUsed ? t('settings.devices.countUsed', { devices: count, when: usedLabel(lastUsed as string) }) : count;
    return (
      <details className="v2p-disc">
        <summary>
          <span className="lb">
            <svg className="v2-settings__icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 6h16v10H4zM2 20h20" /></svg>
            {t('settings.devices.title')}
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
      {confirmDialog}
      <div className="v2-devices__heading"><div>{showHeading && <h2 id="devices-heading">{t('settings.devices.title')}</h2>}<p>{t('settings.devices.lead')}</p></div><button type="button" onClick={() => void load()} disabled={loading}>{t('settings.devices.refresh')}</button></div>
      {error && <p className="v2-devices__error">{error}</p>}
      {loading && <p>{t('settings.devices.loading')}</p>}
      {!loading && devices.length === 0 && <p className="v2-devices__empty">{t('settings.devices.empty')}</p>}
      {!loading && devices.length > 0 && <div className="v2-devices__list">
        {devices.map((device) => <article className="v2-devices__item" key={device.id}>
          <div><strong>{device.label}</strong><span>{t('settings.devices.created', { created: dateLabel(device.createdAt), used: dateLabel(device.lastUsedAt) })}</span></div>
          {device.revokedAt ? <span className="v2-devices__revoked">{t('settings.devices.revoked', { date: dateLabel(device.revokedAt) })}</span> : <button type="button" onClick={() => void revoke(device)}>{t('settings.devices.revoke')}</button>}
        </article>)}
      </div>}
    </section>
    );
  }
};

export default V2DevicesPanel;
