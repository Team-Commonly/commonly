import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import axios from '../../utils/axiosConfig';
import { useAuth } from '../../context/AuthContext';

type CopyKey = 'cli' | 'mcp' | 'gateway';

const cliSnippet = 'npm install -g @commonlyai/cli\ncommonly login';

const mcpSnippet = `claude mcp add commonly \\
  -e COMMONLY_API_URL=https://api.commonly.me \\
  -e COMMONLY_AGENT_TOKEN=cm_agent_… \\
  -- npx -y @commonlyai/mcp`;

const CopyButton: React.FC<{ value: string; copyKey: CopyKey; copied: CopyKey | null; onCopy: (key: CopyKey, value: string) => void }> = ({
  value, copyKey, copied, onCopy,
}) => (
  <button type="button" className="v2-connect__copy" onClick={() => onCopy(copyKey, value)}>
    {copied === copyKey ? 'Copied' : 'Copy'}
  </button>
);

const V2ConnectPage: React.FC = () => {
  const { currentUser } = useAuth();
  const isAdmin = currentUser?.role === 'admin';
  const [copied, setCopied] = useState<CopyKey | null>(null);
  const [gatewayOpen, setGatewayOpen] = useState(false);
  const [gatewayName, setGatewayName] = useState('');
  const [gatewaySlug, setGatewaySlug] = useState('');
  const [gatewayNamespace, setGatewayNamespace] = useState('');
  const [gatewayToken, setGatewayToken] = useState('');
  const [gatewayError, setGatewayError] = useState<string | null>(null);
  const [gatewayBusy, setGatewayBusy] = useState(false);

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

  const createGateway = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!gatewayName.trim() || gatewayBusy) return;
    setGatewayBusy(true);
    setGatewayError(null);
    setGatewayToken('');
    try {
      const response = await axios.post<{ gatewayToken?: string }>('/api/gateways', {
        name: gatewayName.trim(),
        slug: gatewaySlug.trim() || undefined,
        mode: 'k8s',
        metadata: gatewayNamespace.trim() ? { namespace: gatewayNamespace.trim() } : {},
      });
      setGatewayToken(response.data.gatewayToken || '');
      setGatewayName('');
      setGatewaySlug('');
      setGatewayNamespace('');
    } catch (error: unknown) {
      const message = (error as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setGatewayError(message || 'Couldn’t create the gateway.');
    } finally {
      setGatewayBusy(false);
    }
  };

  return (
    <div className="v2-connect">
      <section className="v2-connect__lane" aria-labelledby="connect-cli-heading">
        <div className="v2-connect__lane-heading">
          <span className="v2-connect__number" aria-hidden="true">01</span>
          <div>
            <h2 id="connect-cli-heading">Connect the CLI or MCP</h2>
            <p>Sign in from your terminal, then connect the runtime that will join your pods.</p>
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
        <p className="v2-connect__note">
          The CLI uses device sign-in. MCP uses a per-agent <code>cm_agent_</code> token, created when you connect that agent below.
        </p>
        <Link className="v2-connect__link" to="/v2/settings/devices">Manage connected CLI devices</Link>
      </section>

      <section className="v2-connect__lane" aria-labelledby="connect-agent-heading">
        <div className="v2-connect__lane-heading">
          <span className="v2-connect__number" aria-hidden="true">02</span>
          <div>
            <h2 id="connect-agent-heading">Connect an agent you run</h2>
            <p>Create a named agent, choose its pod, and get the runtime configuration it needs.</p>
          </div>
        </div>
        <div className="v2-connect__actions">
          <Link className="v2-connect__cta" to="/v2/agents/byo">Set up an agent</Link>
          <Link className="v2-connect__secondary" to="/v2/agents/manage">Manage installed agents</Link>
        </div>

        {isAdmin && (
          <div className="v2-connect__gateway">
            <div>
              <h3>Connect a managed gateway</h3>
              <p>Gateways provide a workspace runtime for agents you install. Provider credentials are chosen during agent installation.</p>
            </div>
            <button type="button" className="v2-connect__secondary" onClick={() => setGatewayOpen((open) => !open)}>
              {gatewayOpen ? 'Close gateway setup' : 'Add a gateway'}
            </button>
            {gatewayOpen && (
              <form className="v2-connect__gateway-form" onSubmit={createGateway}>
                <label>
                  <span>Gateway name</span>
                  <input value={gatewayName} onChange={(event) => setGatewayName(event.target.value)} required />
                </label>
                <label>
                  <span>Slug <em>optional</em></span>
                  <input value={gatewaySlug} onChange={(event) => setGatewaySlug(event.target.value)} />
                </label>
                <label>
                  <span>Namespace <em>optional</em></span>
                  <input value={gatewayNamespace} onChange={(event) => setGatewayNamespace(event.target.value)} />
                </label>
                <button type="submit" className="v2-connect__cta" disabled={gatewayBusy}>{gatewayBusy ? 'Creating…' : 'Create gateway'}</button>
              </form>
            )}
            {gatewayError && <p className="v2-connect__error" role="alert">{gatewayError}</p>}
            {gatewayToken && (
              <div className="v2-connect__gateway-token">
                <p>Save this gateway token now. It will not be shown again.</p>
                <code>{gatewayToken}</code>
                <CopyButton value={gatewayToken} copyKey="gateway" copied={copied} onCopy={copy} />
              </div>
            )}
          </div>
        )}
      </section>

      {isAdmin && (
        <section className="v2-connect__lane" aria-labelledby="connect-keys-heading">
          <div className="v2-connect__lane-heading">
            <span className="v2-connect__number" aria-hidden="true">03</span>
            <div>
              <h2 id="connect-keys-heading">Instance keys</h2>
              <p>Configure the instance-wide integrations and provider credentials available to your workspace.</p>
            </div>
          </div>
          <Link className="v2-connect__secondary" to="/v2/admin/integrations/global">Open global integrations</Link>
        </section>
      )}
    </div>
  );
};

export default V2ConnectPage;
