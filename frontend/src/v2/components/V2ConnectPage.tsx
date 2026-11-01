import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import getApiBaseUrl from '../../utils/apiBaseUrl';
import { useAuth } from '../../context/AuthContext';
import cursorMcpInstallLink from '../utils/cursorMcpInstallLink';
import { CURSOR_PROJECT_RULE, CURSOR_PROJECT_RULE_PATH } from '../utils/cursorProjectRule';
import './V2ConnectPage.css';

type CopyKey = 'cli' | 'mcp' | 'cursorRule';

const CopyButton: React.FC<{ value: string; copyKey: CopyKey; copied: CopyKey | null; onCopy: (key: CopyKey, value: string) => void }> = ({
  value, copyKey, copied, onCopy,
}) => (
  <button type="button" className="v2-connect__copy" onClick={() => onCopy(copyKey, value)}>
    {copied === copyKey ? 'Copied' : 'Copy'}
  </button>
);

const V2ConnectPage: React.FC = () => {
  const apiBaseUrl = getApiBaseUrl().replace(/\/+$/, '');
  const cliSnippet = `npm install -g @commonlyai/cli\ncommonly login --instance ${apiBaseUrl}`;
  const cursorInstallHref = cursorMcpInstallLink(apiBaseUrl);
  const mcpSnippet = `claude mcp add commonly \\
  -e COMMONLY_API_URL=${apiBaseUrl} \\
  -e COMMONLY_AGENT_TOKEN=cm_agent_… \\
  -- npx -y @commonlyai/mcp`;
  const { currentUser } = useAuth();
  const isAdmin = currentUser?.role === 'admin';
  const [copied, setCopied] = useState<CopyKey | null>(null);

  const copy = async (key: CopyKey, value: string) => {
    const fallbackCopy = () => {
      const input = document.createElement('textarea');
      input.value = value;
      input.setAttribute('readonly', '');
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      const copied = document.execCommand('copy');
      input.remove();
      return copied;
    };
    try {
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await Promise.race([
          navigator.clipboard.writeText(value),
          new Promise((_, reject) => window.setTimeout(() => reject(new Error('Clipboard timed out')), 500)),
        ]);
      } catch {
        if (!fallbackCopy()) throw new Error('Clipboard unavailable');
      }
      setCopied(key);
      window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 1500);
    } catch {
      // The code block remains selectable when the clipboard is unavailable.
    }
  };

  return (
    <div className="v2-connect">
      <section className="v2-connect__lane" aria-labelledby="connect-cli-heading">
        <div className="v2-connect__lane-heading">
          <span className="v2-connect__number" aria-hidden="true">01</span>
          <div>
            <h2 id="connect-cli-heading">Connect the CLI or MCP</h2>
          </div>
        </div>
        <div className="v2-connect__code-grid">
          <div className="v2-connect__code-card">
            <div className="v2-connect__code-head"><span>Commonly CLI</span><CopyButton value={cliSnippet} copyKey="cli" copied={copied} onCopy={copy} /></div>
            <pre>{cliSnippet}</pre>
          </div>
          <div className="v2-connect__code-card">
            <div className="v2-connect__code-head"><span>Claude Code MCP</span><CopyButton value={mcpSnippet} copyKey="mcp" copied={copied} onCopy={copy} /></div>
            <pre>{mcpSnippet}</pre>
          </div>
        </div>
        <div className="v2-connect__cursor">
          <a className="v2-connect__link" href={cursorInstallHref}>Add Commonly to Cursor</a>
          <span>Add your agent key in Cursor’s MCP settings.</span>
        </div>
        <div className="v2-connect__code-card v2-connect__rule">
          <div className="v2-connect__code-head">
            <span>Cursor rule · save as <code>{CURSOR_PROJECT_RULE_PATH}</code> in your project</span>
            <CopyButton value={CURSOR_PROJECT_RULE} copyKey="cursorRule" copied={copied} onCopy={copy} />
          </div>
          <pre>{CURSOR_PROJECT_RULE}</pre>
        </div>
        <Link className="v2-connect__link" to="/v2/settings">Manage connected CLI devices</Link>
      </section>

      <section className="v2-connect__lane" aria-labelledby="connect-agent-heading">
        <div className="v2-connect__lane-heading">
          <span className="v2-connect__number" aria-hidden="true">02</span>
          <div>
            <h2 id="connect-agent-heading">Connect an agent you run</h2>
          </div>
        </div>
        <div className="v2-connect__actions">
          <Link className="v2-connect__cta" to="/v2/agents/byo">Set up an agent</Link>
          <Link className="v2-connect__secondary" to="/v2/agents">Manage installed agents</Link>
        </div>

      </section>

      {isAdmin && (
        <section className="v2-connect__lane" aria-labelledby="connect-keys-heading">
          <div className="v2-connect__lane-heading">
            <span className="v2-connect__number" aria-hidden="true">03</span>
            <div>
              <h2 id="connect-keys-heading">Instance keys</h2>
            </div>
          </div>
          <Link className="v2-connect__secondary" to="/v2/admin/integrations/global">Open global integrations</Link>
        </section>
      )}
    </div>
  );
};

export default V2ConnectPage;
