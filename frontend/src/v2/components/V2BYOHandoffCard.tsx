import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { V2Message } from '../hooks/useV2PodDetail';

type HandoffOs = 'mac' | 'linux' | 'windows';
const OS_OPTIONS: Array<{ os: HandoffOs; label: string }> = [
  { os: 'mac', label: 'byoHandoff.osMac' },
  { os: 'linux', label: 'byoHandoff.osLinux' },
  { os: 'windows', label: 'byoHandoff.osWindows' },
];

const ADAPTER_GUIDES: Record<string, string> = {
  opencode: 'https://github.com/Team-Commonly/commonly/blob/main/docs/cli/opencode.md',
  dsh: 'https://github.com/Team-Commonly/commonly/blob/main/docs/cli/dsh.md',
};

const browserOs = (): HandoffOs => {
  if (typeof navigator === 'undefined') return 'mac';
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || nav.userAgent || '';
  if (/Windows/i.test(platform)) return 'windows';
  if (/X11|CrOS|Linux/i.test(platform) && !/Android/i.test(platform)) return 'linux';
  return 'mac';
};

const validOs = (value: unknown): value is HandoffOs => (
  value === 'mac' || value === 'linux' || value === 'windows'
);

interface V2BYOHandoffCardProps {
  message: V2Message;
  authorLabel: string;
  time: string | null;
}

const V2BYOHandoffCard: React.FC<V2BYOHandoffCardProps> = ({ message, authorLabel, time }) => {
  const { t } = useTranslation();
  const payload = message.payload || {};
  const supportedOs = (payload.supportedOs || OS_OPTIONS.map(({ os }) => os))
    .filter(validOs)
    .filter((os, index, all) => all.indexOf(os) === index);
  const availableOs = supportedOs.length > 0 ? supportedOs : ['mac' as HandoffOs];
  const requestedOs = validOs(payload.os) ? payload.os : undefined;
  const initialOs = requestedOs && availableOs.includes(requestedOs)
    ? requestedOs
    : (availableOs.includes(browserOs()) ? browserOs() : availableOs[0]);
  const [os, setOs] = useState<HandoffOs>(initialOs);
  const [copied, setCopied] = useState(false);
  const command = payload.commands?.[os] || payload.commands?.[availableOs[0]] || '';
  const adapter = payload.adapter || 'local';
  const adapterLabel = t(`byoHandoff.adapters.${adapter}`, { defaultValue: adapter });
  const adapterGuide = ADAPTER_GUIDES[adapter];

  const copyCommand = async () => {
    if (!command) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(command);
      } else {
        const input = document.createElement('textarea');
        input.value = command;
        input.setAttribute('readonly', '');
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
      }
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="v2-msg v2-msg--system v2-msg--card" data-testid="byo-handoff-card">
      <div className="v2-byo-handoff">
        <div className="v2-byo-handoff__head">
          <span className="v2-byo-handoff__badge">{t('byoHandoff.badge')}</span>
          <span className="v2-byo-handoff__agent">{authorLabel}</span>
          {time && <span className="v2-byo-handoff__time">{time}</span>}
        </div>
        <div className="v2-byo-handoff__title">{t('byoHandoff.title')}</div>
        <div className="v2-byo-handoff__body">
          {t('byoHandoff.body', { adapter: adapterLabel })}
        </div>
        {availableOs.length > 1 && (
          <div className="v2-byo-handoff__os" role="group" aria-label={t('byoHandoff.osLabel')}>
            {OS_OPTIONS.filter(({ os: option }) => availableOs.includes(option)).map(({ os: option, label }) => (
              <button
                key={option}
                type="button"
                className={`v2-byo-handoff__os-btn${os === option ? ' v2-byo-handoff__os-btn--selected' : ''}`}
                aria-pressed={os === option}
                onClick={() => { setOs(option); setCopied(false); }}
              >
                {t(label)}
              </button>
            ))}
          </div>
        )}
        <pre className="v2-byo-handoff__command" data-testid="byo-handoff-command">{command}</pre>
        <button
          type="button"
          className="v2-byo-handoff__copy"
          data-testid="byo-handoff-copy"
          onClick={copyCommand}
          disabled={!command}
        >
          {copied ? t('byoHandoff.copied') : t('byoHandoff.copy')}
        </button>
        {availableOs.length === 1 && (
          <div className="v2-byo-handoff__note">
            {t('byoHandoff.availableOn')}
            {adapterGuide && (
              <>
                {' '}
                <a href={adapterGuide} target="_blank" rel="noopener noreferrer">
                  {t('byoHandoff.setupGuide', { adapter: adapterLabel })}
                </a>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default V2BYOHandoffCard;
