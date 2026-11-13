import React, { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
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

// Claude Code and Codex on native Windows connect from the Bring your own page,
// not from these lines. PowerShell runs the .ps1 shim for a bare `npm` or
// `commonly`, which Windows 11's default script policy refuses (F342), and
// `agent attach` refuses a sandboxed seat on Windows by design, pointing at that
// page. The page issues the key and the PowerShell lines that run with
// --unsandboxed, beside the note on what that means. A stored card may still
// carry Windows commands from before this, so the card never shows them.
const CONNECT_PAGE_ON_WINDOWS = new Set(['claude', 'codex']);

const browserOs = (): HandoffOs => {
  if (typeof navigator === 'undefined') return 'mac';
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || nav.userAgent || '';
  if (/Windows/i.test(platform)) return 'windows';
  if (/X11|CrOS|Linux/i.test(platform) && !/Android/i.test(platform)) return 'linux';
  return 'mac';
};

// The hosted agent whose memory the local one starts with. Cards posted before
// the payload carried it still name it in their other tabs' attach line.
const MEMORY_SOURCE = /^(@[a-z0-9-]+\/)?[a-z0-9-]+$/;
const MEMORY_INSTANCE = /^[a-z0-9][a-z0-9_-]*$/;
const memorySource = (payload: Record<string, any>): { memoryFrom: string; memoryInstance: string } | null => {
  let source = payload.memoryFrom;
  let instance = payload.memoryInstance || 'default';
  if (typeof source !== 'string') {
    const line = Object.values(payload.commands || {}).find((c) => typeof c === 'string' && c.includes('--memory-from '));
    const match = typeof line === 'string' ? line.match(/--memory-from (\S+) --memory-instance (\S+)/) : null;
    if (!match) return null;
    [, source, instance] = match;
  }
  return MEMORY_SOURCE.test(source) && MEMORY_INSTANCE.test(String(instance))
    ? { memoryFrom: source, memoryInstance: String(instance) } : null;
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
  const connectPage = os === 'windows' && CONNECT_PAGE_ON_WINDOWS.has(adapter);
  const connectPageHref = `/v2/agents/byo?${new URLSearchParams({
    ...(payload.podId ? { pod: String(payload.podId) } : {}),
    ...(payload.agentName ? { name: String(payload.agentName) } : {}),
    adapter,
    ...(memorySource(payload) || {}),
  }).toString()}`;

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
          {t(connectPage ? 'byoHandoff.bodyConnectPage' : 'byoHandoff.body', { adapter: adapterLabel })}
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
        {connectPage ? (
          <div className="v2-byo-handoff__note" data-testid="byo-handoff-windows">
            <Trans
              i18nKey="byoHandoff.windowsConnectPage"
              components={{ adapter: <>{adapterLabel}</>, page: <Link to={connectPageHref} /> }}
            />
          </div>
        ) : (
          <>
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
          </>
        )}
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
