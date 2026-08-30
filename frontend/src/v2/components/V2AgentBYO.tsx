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
import V2Avatar from './V2Avatar';
import { useV2Api } from '../hooks/useV2Api';
import { useAuth } from '../../context/AuthContext';
import { V2Pod } from '../hooks/useV2Pods';

const DEFAULT_SCOPES = [
  'context:read', 'summaries:read', 'messages:write', 'messages:read',
  'posts:write', 'posts:read', 'memory:read', 'memory:write',
];
const DEFAULT_AGENT_NAME = 'my-mcp-agent';
const DEFAULT_POD_TYPE = 'chat';
// @latest matters: `agent run` learned to bootstrap from these env vars in
// 0.1.9 — a machine with an older global install must upgrade, not skip the
// line because the binary already resolves.
const CLI_INSTALL_COMMAND = 'npm i -g @commonlyai/cli@latest';
const CLI_INIT_COMMAND = 'commonly agent init --name <n> --pod <podId>';
const MEMORY_FILE_NAME = 'MEMORY.md';
const HOSTED_STATUS_POLL_MS = 4000;
const HOSTED_STATUS_MAX_TICKS = 15;

type HostedAvailability = {
  configured: boolean;
  caps: { agentsPerUser: number; turnsPerDay: number };
};
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
  // Deep-link prefill (?pod=&name=) — the approved connect_local_agent card
  // lands here with the seat Scout proposed already selected, so the user's
  // only remaining act is the token step. Sanitized through the same rules
  // as typed input; an unknown pod id simply falls back to the default pick.
  const prefill = (() => {
    const params = new URLSearchParams(window.location.search);
    return {
      pod: (params.get('pod') || '').replace(/[^a-f0-9]/gi, ''),
      name: sanitizeAgentName(params.get('name') || ''),
    };
  })();
  const [pods, setPods] = useState<V2Pod[]>([]);
  const [podId, setPodId] = useState<string>(prefill.pod);
  // Personalized default: a global-namespace collision guard (#613) means a
  // shared literal default ("my-mcp-agent") 409s for every user after the
  // first one to accept it. Seed from the username so defaults never collide.
  const { currentUser } = useAuth();
  const defaultAgentName = (() => {
    const u = (currentUser?.username || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    return u ? `${u}-agent` : DEFAULT_AGENT_NAME;
  })();
  const [name, setName] = useState<string>(prefill.name || defaultAgentName);
  // currentUser can resolve after mount — refresh the default if untouched.
  useEffect(() => {
    setName((prev) => (prev === DEFAULT_AGENT_NAME && defaultAgentName !== DEFAULT_AGENT_NAME ? defaultAgentName : prev));
  }, [defaultAgentName]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ token: string; agentName: string; podId: string; issuedAt: number } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  // Live listening verification (#887 class, second half). #888 made the
  // listening step legible; this makes it CHECKABLE — the page polls the
  // kernel until THIS agent's runtime token authenticates for the first time
  // after issuance, then flips the step to a checkmark. Without it, users
  // finish the page, mention the agent, and get silence with no way to know
  // which step they missed. 'waiting' → 'listening' | 'timeout'.
  const [listenState, setListenState] = useState<'waiting' | 'listening' | 'timeout'>('waiting');
  // ADR-023 W2 "Run it here" — the zero-terminal path. Offered only when the
  // instance reports a configured hosted runtime, and the default there: the
  // stranger this page exists for has no runtime to bring. The kernel mints
  // the token and hands it to the runtime server-side; nothing secret is
  // ever rendered on this screen.
  const [hosting, setHosting] = useState<HostedAvailability | null>(null);
  const [mode, setMode] = useState<'hosted' | 'byo'>('byo');
  const [hosted, setHosted] = useState<{ agentName: string; podId: string } | null>(null);
  const [hostedState, setHostedState] = useState<'starting' | 'running' | 'slow'>('starting');

  // Same shape as the listening check below, against the runtime's own
  // status: the DO reports lastPollAt once its alarm loop has run. ~60s cap,
  // then honest copy — the agent still picks messages up when it starts.
  useEffect(() => {
    if (!hosted) return undefined;
    let cancelled = false;
    let ticks = 0;
    setHostedState('starting');
    const timer = setInterval(async () => {
      ticks += 1;
      try {
        const data = await api.get<{ runtime?: { lastPollAt?: number | null } }>(
          `/api/hosted/status?agentName=${encodeURIComponent(hosted.agentName)}`,
        );
        if (cancelled) return;
        if (data?.runtime?.lastPollAt) {
          setHostedState('running');
          clearInterval(timer);
          return;
        }
      } catch {
        // keep polling — a transient status failure is not a stopped runtime
      }
      if (ticks >= HOSTED_STATUS_MAX_TICKS) {
        setHostedState('slow');
        clearInterval(timer);
      }
    }, HOSTED_STATUS_POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [api, hosted]);

  // Load the user's pods so they can pick which one to install into.
  // We only show pods they're a member of — install requires membership
  // per the backend's `userHasPodAccess` check. Hosting availability is
  // fetched AFTER pods in the same effect, deliberately: the request order
  // at mount is part of this page's test contract (order-based mocks), and
  // the picker matters more than the mode cards if only one can load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get<V2Pod[]>('/api/pods');
        if (cancelled) return;
        const list = Array.isArray(data) ? data : [];
        const installablePods = list.filter((p) => (
          // Non-DM only: agent-room/agent-dm/agent-admin are strict-1:1
          // surfaces and refuse third-party installs.
          !['agent-room', 'agent-dm', 'agent-admin'].includes(p.type || '')
          // NEVER offer a public/community pod (e.g. Commonly HQ) here. A
          // personal BYO agent attached to a stranger-readable room processes
          // untrusted input — a prompt-injection surface running with the
          // owner's own tokens/compute. New users auto-join HQ and it sorts
          // first by activity, so the old `installablePods[0]` default silently
          // funneled personal agents into the public room (2026-07-24 launch
          // incident). Restrict the picker to non-public pods.
          && p.publicRead !== true
        ));
        setPods(installablePods);
        // A prefilled pod (?pod= deep-link) the user can't actually install
        // into (not in their list) must not survive as a phantom selection.
        const podKnown = podId && installablePods.some((p) => p._id === podId);
        if ((!podId || !podKnown) && installablePods.length > 0) {
          // Default to the user's OWN pod (their private workspace), never the
          // most-active pod. Fall back to the first non-public pod only if the
          // user somehow owns none.
          const uid = currentUser?._id;
          const own = uid
            ? installablePods.find((p) => p.createdBy?._id && String(p.createdBy._id) === String(uid))
            : undefined;
          setPodId((own || installablePods[0])._id);
        }
      } catch {
        // Defensive: keep the form usable; user will see the error on submit.
      }
      try {
        const availability = await api.get<HostedAvailability>('/api/hosted/availability');
        if (cancelled) return;
        if (availability && typeof availability.configured === 'boolean') {
          setHosting(availability);
          if (availability.configured) setMode('hosted');
        }
      } catch {
        if (!cancelled) setHosting({ configured: false, caps: { agentsPerUser: 0, turnsPerDay: 0 } });
      }
    })();
    return () => { cancelled = true; };
  }, [api, podId, currentUser?._id]);

  // Live preview rail — you see the agent you are about to create. The
  // avatar is the same character render the pod will show (seeded by
  // name:instanceId, so the preview face IS the final face), which is what
  // turns this page from a form into a decision about a teammate.
  const previewName = sanitizeAgentName(name) || DEFAULT_AGENT_NAME;
  const previewPodName = pods.find((p) => p._id === (hosted?.podId || issued?.podId || podId))?.name || '';
  const previewStatus: 'draft' | 'starting' | 'live' = hosted
    ? (hostedState === 'running' ? 'live' : 'starting')
    : (issued && listenState === 'listening' ? 'live' : 'draft');
  const previewDisplayName = hosted?.agentName || issued?.agentName || previewName;

  // Hosted path: install with runtimeType 'hosted' (the kernel's cap gate
  // answers 403 hosted_cap_reached), then ask the kernel to provision. No
  // token round-trips through the browser.
  const submitHosted = async (cleanName: string) => {
    setSubmitting(true);
    try {
      try {
        await api.post('/api/registry/install', {
          agentName: cleanName,
          podId,
          scopes: DEFAULT_SCOPES,
          config: { runtime: { runtimeType: 'hosted' } },
          displayName: cleanName,
        });
      } catch (installErr) {
        const data = (installErr as { response?: { data?: { error?: string; code?: string; cap?: number } } })
          ?.response?.data;
        if (data?.code === 'hosted_cap_reached') {
          setError(t('agentByo.errors.hostedCap', { cap: data.cap ?? hosting?.caps.agentsPerUser ?? 1 }));
          return;
        }
        if (!/already installed/i.test(data?.error || '')) throw installErr;
      }
      await api.post('/api/hosted/provision', { agentName: cleanName });
      setHosted({ agentName: cleanName, podId });
    } catch (err) {
      const e = err as { response?: { data?: { error?: string; message?: string; code?: string } }; message?: string };
      const code = e.response?.data?.code;
      setError(code === 'hosted_runtime_unconfigured'
        ? t('agentByo.errors.hostedUnavailable')
        : (e.response?.data?.message || e.response?.data?.error || e.message || t('agentByo.errors.installFailed')));
    } finally {
      setSubmitting(false);
    }
  };

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
    if (mode === 'hosted') {
      await submitHosted(cleanName);
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
        setIssued({
          token: tok, agentName: cleanName, podId, issuedAt: Date.now(),
        });
        setListenState('waiting');
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

  // Poll the kernel for THIS agent's first authenticated check-in after
  // issuance. `/api/users/me/agent-connection` reports the caller's latest
  // agent connection (name + lastUsedAt); the name match plus the
  // issuedAt time-fence means a pre-existing connected agent can never flip
  // the checkmark for the one just issued. 4s cadence sits well inside the
  // endpoint's 60/min budget; polling stops on success, page leave, or after
  // 15 minutes (the user has clearly walked away — leave a static hint).
  useEffect(() => {
    if (!issued || listenState !== 'waiting') return undefined;
    let cancelled = false;
    const startedAt = Date.now();
    const timer = setInterval(async () => {
      if (cancelled) return;
      if (Date.now() - startedAt > 15 * 60 * 1000) {
        setListenState('timeout');
        byoStep('listen-timeout');
        return;
      }
      try {
        const { data } = await axios.get('/api/users/me/agent-connection');
        if (cancelled || !data?.connected) return;
        const sameAgent = String(data.connectedAgent?.agentName || '').toLowerCase()
          === issued.agentName.toLowerCase();
        const afterIssue = data.lastUsedAt
          && new Date(data.lastUsedAt).getTime() >= issued.issuedAt - 60_000; // clock-skew slack
        if (sameAgent && afterIssue) {
          setListenState('listening');
          byoStep('listen-confirmed');
        }
      } catch {
        // Transient read failure — keep polling; the checkmark can only be
        // late, never wrong.
      }
    }, 4000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [issued, listenState]);

  // BYO funnel telemetry: 7 of 7 recent seats died between token issuance and
  // the first authenticated call, and the server cannot see whether the user
  // even copied a command. Fire-and-forget; the flow never waits on it.
  const byoStep = (step: string) => {
    axios.post('/api/stats/byo-step', { step }).catch(() => {});
  };

  const copy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
      if (key === 'claude' || key === 'cursor') byoStep('mcp-command-copied');
      else if (key === 'listen') byoStep('cli-command-copied');
      else if (key === 'tok') byoStep('token-copied');
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

  // The command that makes the agent LISTEN. Everything above is the calling
  // direction only; this is the one that answers @mentions. The CLI-install
  // line rides INSIDE the snippet: it used to live in a footnote on the
  // previous screen, so first-time users hit "command not found" one step
  // after we stopped watching (#887 class).
  const listenSnippet = issued
    ? `# install or update the CLI first: ${CLI_INSTALL_COMMAND}\nexport COMMONLY_API_URL=${apiUrl}\nexport COMMONLY_AGENT_TOKEN=${issued.token}\ncommonly agent run ${issued.agentName}`
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
      <div className="v2-byo__layout">
      <div className="v2-byo__main">
      {!issued && !hosted && (
        <div className="v2-byo__form">
          {hosting?.configured && (
            <div className="v2-byo__modes" role="group" aria-label={t('agentByo.mode.label')}>
              <button
                type="button"
                className="v2-byo__mode"
                aria-pressed={mode === 'hosted'}
                onClick={() => setMode('hosted')}
                data-testid="byo-mode-hosted"
              >
                <span className="v2-byo__mode-kicker">{t('agentByo.mode.recommended')}</span>
                <span className="v2-byo__mode-title">{t('agentByo.mode.hosted')}</span>
                <span className="v2-byo__hint">{t('agentByo.mode.hostedHint', { turns: hosting.caps.turnsPerDay })}</span>
                <span className="v2-byo__mode-meta">{t('agentByo.mode.hostedMeta')}</span>
              </button>
              <button
                type="button"
                className="v2-byo__mode"
                aria-pressed={mode === 'byo'}
                onClick={() => setMode('byo')}
                data-testid="byo-mode-byo"
              >
                <span className="v2-byo__mode-kicker v2-byo__mode-kicker--quiet">{t('agentByo.mode.yours')}</span>
                <span className="v2-byo__mode-title">{t('agentByo.mode.byo')}</span>
                <span className="v2-byo__hint">{t('agentByo.mode.byoHint')}</span>
                <span className="v2-byo__mode-meta">{t('agentByo.mode.byoMeta')}</span>
              </button>
            </div>
          )}
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
            {mode === 'hosted'
              ? (submitting ? t('agentByo.actions.starting') : t('agentByo.actions.runHere'))
              : (submitting ? t('agentByo.actions.issuing') : t('agentByo.actions.install'))}
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

      {hosted && (
        <div className="v2-byo__result" data-testid="byo-hosted-result">
          <div className="v2-byo__result-hero">
            <V2Avatar name={hosted.agentName} size="lg" kind="agent" seed={`${hosted.agentName}:default`} online={hostedState === 'running'} />
            <h2>{t('agentByo.hosted.heading')} <code>{hosted.agentName}</code></h2>
          </div>
          <p>
            {t('agentByo.hosted.live', {
              name: hosted.agentName,
              pod: pods.find((p) => p._id === hosted.podId)?.name || '',
            })}
          </p>
          <p
            className={hostedState === 'running' ? 'v2-byo__memory-done' : 'v2-byo__listen-note'}
            data-testid={`byo-hosted-${hostedState}`}
          >
            {t(`agentByo.hosted.${hostedState}`, { name: hosted.agentName })}
          </p>
          <div className="v2-byo__stats">
            <div className="v2-byo__stat">
              <span className="v2-byo__stat-value">{hosting?.caps.turnsPerDay ?? 0}</span>
              <span className="v2-byo__stat-label">{t('agentByo.hosted.statTurns')}</span>
            </div>
            <div className="v2-byo__stat">
              <span className="v2-byo__stat-value">{hosting?.caps.agentsPerUser ?? 1}</span>
              <span className="v2-byo__stat-label">{t('agentByo.hosted.statAgents')}</span>
            </div>
            <div className="v2-byo__stat">
              <span className="v2-byo__stat-value">~10s</span>
              <span className="v2-byo__stat-label">{t('agentByo.hosted.statLatency')}</span>
            </div>
          </div>
          <div className="v2-byo__cta-row">
            <button
              type="button"
              onClick={() => navigate(`/v2/pods/${hosted.podId}`)}
              className="v2-byo__submit"
            >
              {t('agentByo.actions.goToPod')}
            </button>
            <button
              type="button"
              onClick={() => { setHosted(null); }}
              className="v2-byo__secondary"
            >
              {t('agentByo.actions.installAnother')}
            </button>
          </div>
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

          {/*
            The MCP snippets above make the agent able to CALL Commonly from the
            user's editor. They do not make it answer @mentions here — nothing
            polls. Users finished this flow, saw the agent in Your Team,
            mentioned it, and got silence; 4 of 6 mentions in 10 days went
            unanswered for exactly this reason (#887). The consequence belongs
            at the point of the promise, not in a footnote.
          */}
          <div className="v2-byo__snippet v2-byo__snippet--listen">
            <div className="v2-byo__snippet-head">
              <span>{t('agentByo.listen.title')}</span>
              <button
                type="button"
                onClick={() => copy('listen', listenSnippet)}
                className="v2-byo__copy"
              >
                {copied === 'listen' ? t('agentByo.actions.copied') : t('agentByo.actions.copy')}
              </button>
            </div>
            <p className="v2-byo__listen-body">{t('agentByo.listen.body')}</p>
            <pre className="v2-byo__pre">{listenSnippet}</pre>
            {listenState === 'listening' ? (
              <p className="v2-byo__memory-done" data-testid="byo-listen-ok">
                {t('agentByo.listen.verified', { name: issued.agentName })}
              </p>
            ) : (
              <p className="v2-byo__listen-note" data-testid="byo-listen-waiting">
                {listenState === 'timeout'
                  ? t('agentByo.listen.stillWaiting', { name: issued.agentName })
                  : t('agentByo.listen.waiting', { name: issued.agentName })}
              </p>
            )}
            <p className="v2-byo__listen-note">
              {t('agentByo.listen.note', { name: issued.agentName })}
            </p>
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
            {listenState !== 'listening' && (
              // Honest copy at the point of departure (#891 principle 6):
              // never block the button — MCP-only setups are legitimate —
              // but a user leaving before the checkmark must know mentions
              // will not be answered yet.
              <span className="v2-byo__listen-note" data-testid="byo-cta-warning">
                {t('agentByo.listen.ctaWarning', { name: issued.agentName })}
              </span>
            )}
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
      </div>
      <aside className="v2-byo__preview" data-testid="byo-preview">
        <div className="v2-byo__preview-label">{t('agentByo.preview.title')}</div>
        <div className="v2-byo__preview-card">
          <V2Avatar
            name={previewDisplayName}
            size="lg"
            kind="agent"
            seed={`${previewDisplayName}:default`}
            online={previewStatus === 'live'}
          />
          <div className="v2-byo__preview-name">{previewDisplayName}</div>
          {previewPodName && (
            <div className="v2-byo__preview-pod">{t('agentByo.preview.inPod', { pod: previewPodName })}</div>
          )}
          <div className={`v2-byo__preview-status v2-byo__preview-status--${previewStatus}`}>
            <span className="v2-byo__preview-dot" />
            {t(`agentByo.preview.${previewStatus}`)}
          </div>
        </div>
        <p className="v2-byo__preview-note">
          {mode === 'hosted' ? t('agentByo.preview.noteHosted') : t('agentByo.preview.noteByo')}
        </p>
      </aside>
      </div>
    </V2FeaturePage>
  );
};

export default V2AgentBYO;
