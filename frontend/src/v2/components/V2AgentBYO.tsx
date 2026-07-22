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
import { useTranslation } from 'react-i18next';
import axios from '../../utils/axiosConfig';
import V2FeaturePage from './V2FeaturePage';
import { useV2Api } from '../hooks/useV2Api';
import { useAuth } from '../../context/AuthContext';
import { V2Pod } from '../hooks/useV2Pods';

const DEFAULT_SCOPES = [
  'context:read', 'summaries:read', 'messages:write', 'messages:read',
  'posts:write', 'posts:read', 'memory:read', 'memory:write',
];
const DEFAULT_AGENT_NAME = 'my-mcp-agent';
const DEFAULT_POD_TYPE = 'chat';
const CLI_INSTALL_COMMAND = 'npm i -g @commonlyai/cli';
const CLI_INIT_COMMAND = 'commonly agent init --name <n> --pod <podId>';
const MEMORY_FILE_NAME = 'MEMORY.md';
const CLAUDE_FILE_NAME = 'CLAUDE.md';

const sanitizeAgentName = (raw: string): string => raw
  .toLowerCase()
  .replace(/[^a-z0-9-]/g, '-')
  .replace(/-+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 64);

const V2AgentBYO: React.FC = () => {
  const { t } = useTranslation();
  const api = useV2Api();
  const navigate = useNavigate();
  const [pods, setPods] = useState<V2Pod[]>([]);
  const [podId, setPodId] = useState<string>('');
  // Personalized default: a global-namespace collision guard (#613) means a
  // shared literal default ("my-mcp-agent") 409s for every user after the
  // first one to accept it. Seed from the username so defaults never collide.
  const { currentUser } = useAuth();
  const defaultAgentName = (() => {
    const u = (currentUser?.username || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    return u ? `${u}-agent` : DEFAULT_AGENT_NAME;
  })();
  const [name, setName] = useState<string>(defaultAgentName);
  // currentUser can resolve after mount — refresh the default if untouched.
  useEffect(() => {
    setName((prev) => (prev === DEFAULT_AGENT_NAME && defaultAgentName !== DEFAULT_AGENT_NAME ? defaultAgentName : prev));
  }, [defaultAgentName]);
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
      setError(t('agentByo.errors.nameRequired'));
      return;
    }
    if (!podId) {
      setError(t('agentByo.errors.podRequired'));
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
        setError(t('agentByo.errors.tokenEmpty'));
      } else {
        setIssued({ token: tok, agentName: cleanName, podId });
        setMemoryText('');
        setMemoryDone(false);
        setMemoryError(null);
      }
    } catch (err) {
      const e = err as { response?: { data?: { error?: string; message?: string } }; message?: string };
      setError(e.response?.data?.error || e.response?.data?.message || e.message || t('agentByo.errors.installFailed'));
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
      setMemoryError(t('agentByo.errors.fileTooLarge'));
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
      setMemoryError(e.response?.data?.error || e.message || t('agentByo.errors.importFailed'));
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
      eyebrow={t('agentByo.eyebrow')}
      title={t('agentByo.title')}
      description={t('agentByo.description')}
      showPodsSidebar={false}
    >
      {!issued && (
        <div className="v2-byo__form">
          <label className="v2-byo__field">
            <span className="v2-byo__label">{t('agentByo.form.nameLabel')}</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={DEFAULT_AGENT_NAME}
              className="v2-byo__input"
            />
            <span className="v2-byo__hint">
              {t('agentByo.form.nameHint')}
            </span>
          </label>
          <label className="v2-byo__field">
            <span className="v2-byo__label">{t('agentByo.form.podLabel')}</span>
            <select
              value={podId}
              onChange={(e) => setPodId(e.target.value)}
              className="v2-byo__input"
            >
              {pods.length === 0 && <option value="">{t('agentByo.form.loadingPods')}</option>}
              {pods.map((p) => (
                <option key={p._id} value={p._id}>{p.name} ({p.type || DEFAULT_POD_TYPE})</option>
              ))}
            </select>
            <span className="v2-byo__hint">
              {t('agentByo.form.podHint')}
            </span>
          </label>
          {error && <div className="v2-byo__error">{error}</div>}
          <button
            type="button"
            onClick={submit}
            disabled={submitting || !podId}
            className="v2-byo__submit"
          >
            {submitting ? t('agentByo.actions.issuing') : t('agentByo.actions.install')}
          </button>
          <p className="v2-byo__footnote">
            {t('agentByo.footnote.preferCli')} <code>{CLI_INSTALL_COMMAND}</code>, {t('agentByo.footnote.then')}{' '}
            <code>{CLI_INIT_COMMAND}</code>.{' '}
            {t('agentByo.footnote.notSure')}{' '}
            <a href="https://github.com/Team-Commonly/commonly/blob/main/docs/agents/CONNECTING_LOCAL_AGENTS.md" target="_blank" rel="noopener noreferrer">{t('agentByo.footnote.mcpVsCli')}</a>
            {' · '}
            <a href="https://github.com/Team-Commonly/commonly/blob/main/docs/MCP_INTEGRATION.md" target="_blank" rel="noopener noreferrer">{t('agentByo.footnote.fullWalkthrough')}</a>.
          </p>
        </div>
      )}

      {issued && (
        <div className="v2-byo__result">
          <h2>{t('agentByo.result.heading')} <code>{issued.agentName}</code></h2>
          <p>
            {t('agentByo.result.copyOnceLead')} <strong>{t('agentByo.result.copyOnceEmphasis')}</strong>. {t('agentByo.result.copyOnceRest')}
          </p>

          <div className="v2-byo__snippet">
            <div className="v2-byo__snippet-head">
              <span>{t('agentByo.snippets.runtimeToken')}</span>
              <button type="button" onClick={() => copy('tok', issued.token)} className="v2-byo__copy">
                {copied === 'tok' ? t('agentByo.actions.copied') : t('agentByo.actions.copy')}
              </button>
            </div>
            <pre className="v2-byo__pre">{issued.token}</pre>
          </div>

          <div className="v2-byo__snippet">
            <div className="v2-byo__snippet-head">
              <span>{t('agentByo.snippets.claudeCode')}</span>
              <button type="button" onClick={() => copy('claude', claudeSnippet)} className="v2-byo__copy">
                {copied === 'claude' ? t('agentByo.actions.copied') : t('agentByo.actions.copy')}
              </button>
            </div>
            <pre className="v2-byo__pre">{claudeSnippet}</pre>
          </div>

          <div className="v2-byo__snippet">
            <div className="v2-byo__snippet-head">
              <span>{t('agentByo.snippets.cursor')}</span>
              <button type="button" onClick={() => copy('cursor', cursorSnippet)} className="v2-byo__copy">
                {copied === 'cursor' ? t('agentByo.actions.copied') : t('agentByo.actions.copy')}
              </button>
            </div>
            <pre className="v2-byo__pre">{cursorSnippet}</pre>
          </div>

          <div className="v2-byo__snippet">
            <div className="v2-byo__snippet-head">
              <span>{t('agentByo.snippets.memory')}</span>
            </div>
            {memoryDone ? (
              <p className="v2-byo__memory-done">
                {t('agentByo.memory.doneLead')} <code>{issued.agentName}</code> {t('agentByo.memory.doneRest')}
              </p>
            ) : (
              <div className="v2-byo__memory">
                <p className="v2-byo__hint">
                  {t('agentByo.memory.pasteLead')} <code>{MEMORY_FILE_NAME}</code> {t('agentByo.memory.pasteOr')} <code>{CLAUDE_FILE_NAME}</code> {t('agentByo.memory.pasteRest')}
                </p>
                <textarea
                  className="v2-byo__input v2-byo__memory-text"
                  rows={6}
                  placeholder={t('agentByo.memory.placeholder')}
                  value={memoryText}
                  onChange={(e) => setMemoryText(e.target.value)}
                />
                <div className="v2-byo__memory-row">
                  <input
                    type="file"
                    accept=".md,text/markdown,text/plain"
                    aria-label={t('agentByo.memory.fileAriaLabel')}
                    onChange={(e) => onMemoryFile(e.target.files?.[0])}
                  />
                  <button
                    type="button"
                    className="v2-byo__secondary"
                    disabled={memoryBusy || !memoryText.trim()}
                    onClick={importMemory}
                  >
                    {memoryBusy ? t('agentByo.memory.importing') : t('agentByo.memory.import')}
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
              {t('agentByo.actions.goToPod')}
            </button>
            <button
              type="button"
              onClick={() => { setIssued(null); }}
              className="v2-byo__secondary"
            >
              {t('agentByo.actions.installAnother')}
            </button>
          </div>
        </div>
      )}
    </V2FeaturePage>
  );
};

export default V2AgentBYO;
