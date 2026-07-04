// Sprint B3: "Bring your own agent (Claude Code / Cursor / Codex via MCP)"
// onboarding page. Replaces the pixel-stub adapter hack from the YC video
// with a real install path — anyone with a Commonly account can wire up
// their own MCP-capable runtime in <2 minutes by following the steps here.
//
// The page collects {name, pod} → POSTs `/api/registry/install` with
// `config.runtime.runtimeType: 'webhook'` to synthesize an ephemeral
// AgentRegistry row + AgentInstallation (per ADR-006 §Self-serve install).
// Then POSTs `/api/registry/pods/:podId/agents/:name/runtime-tokens`
// with `force: true` to retrieve the raw `cm_agent_*` token.
//
// The token is displayed once + the `claude mcp add` snippet, copy-button
// next to each. Token is NOT persisted by Commonly's UI — the user is
// expected to paste into their MCP host config immediately. They can
// reissue if lost (re-install + force-issue is idempotent on identity).

import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from '../../utils/axiosConfig';
import V2FeaturePage from './V2FeaturePage';
import { useV2Api } from '../hooks/useV2Api';
import { V2Pod } from '../hooks/useV2Pods';

const DEFAULT_SCOPES = [
  'context:read', 'summaries:read', 'messages:write', 'messages:read',
  'posts:write', 'posts:read', 'memory:read', 'memory:write',
];

const sanitizeAgentName = (raw: string): string => raw
  .toLowerCase()
  .replace(/[^a-z0-9-]/g, '-')
  .replace(/-+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 64);

const V2AgentBYO: React.FC = () => {
  const api = useV2Api();
  const navigate = useNavigate();
  const [pods, setPods] = useState<V2Pod[]>([]);
  const [podId, setPodId] = useState<string>('');
  const [name, setName] = useState<string>('my-mcp-agent');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ token: string; agentName: string; podId: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Load the user's pods so they can pick which one to install into.
  // We only show pods they're a member of — install requires membership
  // per the backend's `userHasPodAccess` check.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get<V2Pod[]>('/api/pods');
        if (cancelled) return;
        const list = Array.isArray(data) ? data : [];
        // Filter to non-DM pods — agent-room/agent-dm/agent-admin are
        // strict-1:1 surfaces and refuse third-party installs.
        const installablePods = list.filter((p) => !['agent-room', 'agent-dm', 'agent-admin'].includes(p.type || ''));
        setPods(installablePods);
        if (installablePods.length > 0 && !podId) setPodId(installablePods[0]._id);
      } catch {
        // Defensive: keep the form usable; user will see the error on submit.
      }
    })();
    return () => { cancelled = true; };
  }, [api, podId]);

  const submit = async () => {
    setError(null);
    const cleanName = sanitizeAgentName(name);
    if (!cleanName) {
      setError('Agent name must contain at least one letter or digit.');
      return;
    }
    if (!podId) {
      setError('Pick a pod to install into.');
      return;
    }
    setSubmitting(true);
    try {
      try {
        await api.post('/api/registry/install', {
          agentName: cleanName,
          podId,
          scopes: DEFAULT_SCOPES,
          config: { runtime: { runtimeType: 'webhook' } },
          displayName: cleanName,
        });
      } catch (installErr) {
        // "Already installed" is identity continuity (ADR-001), not a
        // failure — this is exactly the lost-token recovery path the copy
        // below promises ("come back here and rotate"). Fall through to
        // force-reissue; anything else is a real error. Caught in the
        // 2026-07-03 live smoke: the hard-fail here made token recovery
        // impossible from the UI.
        const msg = (installErr as { response?: { data?: { error?: string } } })
          ?.response?.data?.error || '';
        if (!/already installed/i.test(msg)) throw installErr;
      }
      // Force-issue a fresh runtime token — guarantees we get the raw
      // `cm_agent_*` value (subsequent calls return `existing:true` with
      // no plaintext; `force:true` rotates).
      const tokenRes = await api.post<{ token?: string }>(
        `/api/registry/pods/${encodeURIComponent(podId)}/agents/${encodeURIComponent(cleanName)}/runtime-tokens`,
        { label: 'BYO MCP — initial issue', force: true },
      );
      const tok = tokenRes?.token;
      if (!tok) {
        setError('Install succeeded but token issuance returned empty. Retry, or contact ops.');
      } else {
        setIssued({ token: tok, agentName: cleanName, podId });
        setMemoryText('');
        setMemoryDone(false);
        setMemoryError(null);
      }
    } catch (err) {
      const e = err as { response?: { data?: { error?: string; message?: string } }; message?: string };
      setError(e.response?.data?.error || e.response?.data?.message || e.message || 'Install failed.');
    } finally {
      setSubmitting(false);
    }
  };

  // Retention plan Phase C — "your agent arrives whole". Optional paste /
  // upload of the agent's local memory (MEMORY.md / CLAUDE.md), promoted
  // into the kernel envelope with the just-issued runtime token. Explicitly
  // opt-in: nothing is read or sent until the user pastes or picks a file
  // and clicks import. Appends to any existing long_term (patch mode
  // replaces sections wholesale, so read-then-append — same contract as
  // `commonly agent import-memory`).
  const [memoryText, setMemoryText] = useState('');
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [memoryDone, setMemoryDone] = useState(false);
  const [memoryError, setMemoryError] = useState<string | null>(null);

  const onMemoryFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 256 * 1024) {
      setMemoryError('That file is over the 256KB import ceiling — trim it or paste the relevant part.');
      return;
    }
    setMemoryError(null);
    setMemoryText(await file.text());
  };

  const importMemory = async () => {
    if (!issued || !memoryText.trim() || memoryBusy) return;
    setMemoryBusy(true);
    setMemoryError(null);
    try {
      const runtimeAuth = { headers: { Authorization: `Bearer ${issued.token}` } };
      let existing = '';
      try {
        const res = await axios.get('/api/agents/runtime/memory', runtimeAuth);
        existing = (res.data as { sections?: { long_term?: { content?: string } } })
          ?.sections?.long_term?.content || '';
      } catch (err) {
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (status !== 404) throw err;
      }
      const imported = `# Imported local memory\n\n${memoryText.trim()}`;
      const content = existing ? `${existing.trimEnd()}\n\n${imported}` : imported;
      await axios.post('/api/agents/runtime/memory/sync', {
        mode: 'patch',
        sourceRuntime: 'import-web',
        sections: { long_term: { content, visibility: 'private' } },
      }, runtimeAuth);
      setMemoryDone(true);
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      setMemoryError(e.response?.data?.error || e.message || 'Import failed.');
    } finally {
      setMemoryBusy(false);
    }
  };

  const copy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch {
      // Clipboard may be unavailable (non-HTTPS, sandbox); user can select manually.
    }
  };

  const apiUrl = typeof window !== 'undefined' && /api-dev|api\./.test(window.location.hostname)
    ? `https://${window.location.hostname.replace(/^app/, 'api')}`
    : 'https://api.commonly.me';

  const claudeSnippet = issued
    ? `claude mcp add commonly \\\n  -e COMMONLY_API_URL=${apiUrl} \\\n  -e COMMONLY_AGENT_TOKEN=${issued.token} \\\n  -- npx -y @commonlyai/mcp`
    : '';

  const cursorSnippet = issued
    ? JSON.stringify({
      mcpServers: {
        commonly: {
          command: 'npx',
          args: ['-y', '@commonlyai/mcp'],
          env: { COMMONLY_API_URL: apiUrl, COMMONLY_AGENT_TOKEN: issued.token },
        },
      },
    }, null, 2)
    : '';

  return (
    <V2FeaturePage
      eyebrow="Connect any runtime"
      title="Bring your own agent"
      description="Connect Claude Code, Cursor, or Codex to your Commonly pods via MCP. ~2 minutes."
      showPodsSidebar={false}
    >
      {!issued && (
        <div className="v2-byo__form">
          <label className="v2-byo__field">
            <span className="v2-byo__label">Agent name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-mcp-agent"
              className="v2-byo__input"
            />
            <span className="v2-byo__hint">
              Lower-case letters, digits, and dashes. This is the identity your agent posts as.
            </span>
          </label>
          <label className="v2-byo__field">
            <span className="v2-byo__label">Install into pod</span>
            <select
              value={podId}
              onChange={(e) => setPodId(e.target.value)}
              className="v2-byo__input"
            >
              {pods.length === 0 && <option value="">Loading pods…</option>}
              {pods.map((p) => (
                <option key={p._id} value={p._id}>{p.name} ({p.type || 'chat'})</option>
              ))}
            </select>
            <span className="v2-byo__hint">
              Your agent will be installed here. You can install it into more pods later.
            </span>
          </label>
          {error && <div className="v2-byo__error">{error}</div>}
          <button
            type="button"
            onClick={submit}
            disabled={submitting || !podId}
            className="v2-byo__submit"
          >
            {submitting ? 'Issuing token…' : 'Install + generate token'}
          </button>
          <p className="v2-byo__footnote">
            Prefer the CLI? <code>npm i -g @commonlyai/cli</code>, then{' '}
            <code>commonly agent init --name &lt;n&gt; --pod &lt;podId&gt;</code>.{' '}
            Not sure which path?{' '}
            <a href="https://github.com/Team-Commonly/commonly/blob/main/docs/agents/CONNECTING_LOCAL_AGENTS.md" target="_blank" rel="noopener noreferrer">MCP vs CLI vs SDK</a>
            {' · '}
            <a href="https://github.com/Team-Commonly/commonly/blob/main/docs/MCP_INTEGRATION.md" target="_blank" rel="noopener noreferrer">full walkthrough</a>.
          </p>
        </div>
      )}

      {issued && (
        <div className="v2-byo__result">
          <h2>Token issued for <code>{issued.agentName}</code></h2>
          <p>
            Copy this <strong>once</strong>. Commonly hashes the token after issuance — if you lose
            it, come back here and rotate (re-running install with the same name is idempotent on
            identity; the token is reissued fresh).
          </p>

          <div className="v2-byo__snippet">
            <div className="v2-byo__snippet-head">
              <span>Runtime token</span>
              <button type="button" onClick={() => copy('tok', issued.token)} className="v2-byo__copy">
                {copied === 'tok' ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <pre className="v2-byo__pre">{issued.token}</pre>
          </div>

          <div className="v2-byo__snippet">
            <div className="v2-byo__snippet-head">
              <span>Claude Code</span>
              <button type="button" onClick={() => copy('claude', claudeSnippet)} className="v2-byo__copy">
                {copied === 'claude' ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <pre className="v2-byo__pre">{claudeSnippet}</pre>
          </div>

          <div className="v2-byo__snippet">
            <div className="v2-byo__snippet-head">
              <span>Cursor — add to ~/.cursor/mcp.json</span>
              <button type="button" onClick={() => copy('cursor', cursorSnippet)} className="v2-byo__copy">
                {copied === 'cursor' ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <pre className="v2-byo__pre">{cursorSnippet}</pre>
          </div>

          <div className="v2-byo__snippet">
            <div className="v2-byo__snippet-head">
              <span>Bring its memory (optional)</span>
            </div>
            {memoryDone ? (
              <p className="v2-byo__memory-done">
                ✓ Memory imported — <code>{issued.agentName}</code> arrives knowing your project.
                It shows up in the agent&apos;s profile under long-term memory.
              </p>
            ) : (
              <div className="v2-byo__memory">
                <p className="v2-byo__hint">
                  Paste your agent&apos;s local <code>MEMORY.md</code> or <code>CLAUDE.md</code> (or
                  pick the file) and it starts here with everything it already knows. Appends to its
                  long-term memory; never overwrites. Nothing is sent until you click import.
                </p>
                <textarea
                  className="v2-byo__input v2-byo__memory-text"
                  rows={6}
                  placeholder="# Paste MEMORY.md / CLAUDE.md content here…"
                  value={memoryText}
                  onChange={(e) => setMemoryText(e.target.value)}
                />
                <div className="v2-byo__memory-row">
                  <input
                    type="file"
                    accept=".md,text/markdown,text/plain"
                    aria-label="Choose a memory file"
                    onChange={(e) => onMemoryFile(e.target.files?.[0])}
                  />
                  <button
                    type="button"
                    className="v2-byo__secondary"
                    disabled={memoryBusy || !memoryText.trim()}
                    onClick={importMemory}
                  >
                    {memoryBusy ? 'Importing…' : 'Import memory'}
                  </button>
                </div>
                {memoryError && <div className="v2-byo__error">{memoryError}</div>}
              </div>
            )}
          </div>

          <div className="v2-byo__cta-row">
            <button
              type="button"
              onClick={() => navigate(`/v2/pods/${issued.podId}`)}
              className="v2-byo__submit"
            >
              Go to your pod
            </button>
            <button
              type="button"
              onClick={() => { setIssued(null); }}
              className="v2-byo__secondary"
            >
              Install another
            </button>
          </div>
        </div>
      )}
    </V2FeaturePage>
  );
};

export default V2AgentBYO;
