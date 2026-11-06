// Sprint B3: "Bring your own agent (Claude Code / Cursor / Codex via MCP)"
// onboarding page. Replaces the pixel-stub adapter hack from the YC video
// with a real install path — anyone with a Commonly account can wire up
// their own MCP-capable runtime in <2 minutes by following the steps here.
//
// The page collects {name, pod} → POSTs `/api/registry/install` with
// `config.runtime.runtimeType: 'webhook'` to synthesize an ephemeral
// AgentRegistry row + AgentInstallation (per ADR-006 §Self-serve install).
// Then POSTs `/api/registry/pods/:podId/agents/:name/runtime-tokens`
// without rotation to retrieve a new `cm_agent_*` token. Replacing an
// existing key requires an explicit second action.
//
// The token is displayed once + the `claude mcp add` snippet, copy-button
// next to each. Token is NOT persisted by Commonly's UI — the user is
// expected to paste into their MCP host config immediately. If lost, they
// can explicitly replace the old key without changing the agent identity.

import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import axios from '../../utils/axiosConfig';
import { recordByoStep, type ByoCopyType, type ByoStep } from '../utils/byoTelemetry';
import getApiBaseUrl from '../../utils/apiBaseUrl';
import { daemonSetupCommand } from '../utils/daemonSetupCommand';
import { defaultMachine, machineDisplayName } from '../utils/machineLabel';
import V2FeaturePage from './V2FeaturePage';
import V2Avatar from './V2Avatar';
import V2Hint from './V2Hint';
import { useV2Api } from '../hooks/useV2Api';
import { useAuth } from '../../context/AuthContext';
import { V2Pod } from '../hooks/useV2Pods';
import { PERSONA_CARDS } from '../agents/personaCatalogData';
import { DEFAULT_INSTALL_SCOPES } from '../utils/agentInstallScopes';
import { hostedCapNotice } from './hostedCapNotice';
import { readPodVisits } from '../lib/podRecency';
import { AgentConnection, connectionLabel } from '../utils/agentConnection';
import cursorMcpInstallLink from '../utils/cursorMcpInstallLink';
import {
  FALLBACK_HARNESSES, HarnessCatalogEntry, HarnessDeviceRow, KNOWN_HARNESS_IDS, connectorGrantBlock, harnessDeviceNote, harnessLabel,
  orderHarnessIds,
} from '../utils/harnessCatalog';
import V2HarnessChoice from './V2HarnessChoice';
import { InstallNarrowing, V2InstallNarrowingNotice, installNarrowingFromError } from './V2OutsiderGrantNarrowing';
import './V2AgentBYO.css';

const DEFAULT_AGENT_NAME = 'my-mcp-agent';
// The token routes refuse a name that belongs to an agent Commonly runs (the
// person's hosted agent): say that, not "has no runtime token".
const IN_PROCESS_NAME_CODE = 'in_process_agent_no_token';
const DEFAULT_POD_TYPE = 'chat';
// @latest matters: `agent run` learned to bootstrap from these env vars in
// 0.1.9 — a machine with an older global install must upgrade, not skip the
// line because the binary already resolves.
const CLI_INSTALL_COMMAND = 'npm i -g @commonlyai/cli@latest';
const MEMORY_FILE_NAME = 'MEMORY.md';

// A PowerShell double-quoted string treats ` as its escape and expands $, and
// it ends at " and at the typographic quotes (U+201C, U+201D, U+201E), which
// it reads as the same character. Each one gets a backtick. The key is opaque,
// so the escape assumes nothing about its alphabet.
const POWERSHELL_SPECIAL = /[`"$\u201C\u201D\u201E]/g;
export const powerShellQuote = (value: string): string => '"' + value.replace(POWERSHELL_SPECIAL, (ch) => '`' + ch) + '"';

export type ConnectSnippetOs = 'unix' | 'windows';
// The command that makes the agent LISTEN, for bash/zsh or for PowerShell.
// PowerShell has no `export`; its form is `$env:NAME="value"`, which also lasts
// only in that window. Install line and run line are the same on both, except
// that on native Windows `agent run` refuses without --unsandboxed: there is no
// sandbox there, and the flag is the person choosing to run without one. For
// Codex the CLI also requires every pod to be invite-only, so the page offers
// this line only in such a pod (listenerRunsOn).
export const connectSnippet = ({
  os, apiUrl, token, agentName, adapter, allow = '',
}: {
  os: ConnectSnippetOs;
  apiUrl: string;
  token: string;
  agentName: string;
  adapter: string;
  allow?: string;
}): string => {
  const env = os === 'windows'
    ? [`$env:COMMONLY_API_URL=${powerShellQuote(apiUrl)}`, `$env:COMMONLY_AGENT_TOKEN=${powerShellQuote(token)}`]
    : [`export COMMONLY_API_URL=${apiUrl}`, `export COMMONLY_AGENT_TOKEN=${token}`];
  return [
    CLI_INSTALL_COMMAND,
    ...env,
    `commonly agent run ${agentName} --adapter ${adapter}${allow ? ` --allow ${allow}` : ''}${os === 'windows' ? ' --unsandboxed' : ''}`,
  ].join('\n');
};
// D247: OpenCode can't start from the page's key: a public OpenCode seat needs
// a provider and a key file on that Mac (adapters/opencode.js), so it is
// connected with `agent attach --env`, as docs/cli/opencode.md walks. The key
// is typed into its own line first, because a pasted block would feed its own
// next line to the prompt. A public seat never uses the person's own OpenCode
// login (adapters/opencode.js), so a provider is named: Anthropic's
// OpenAI-compatible endpoint is the example, and any OpenAI-compatible
// provider works by changing baseURL and model.
export const OPENCODE_DEFAULT_MODEL = 'claude-haiku-5-5';
export const opencodeKeySnippet = (): string => (
  '(umask 077; mkdir -p ~/.config/commonly; printf \'Anthropic API key: \'; stty -echo; IFS= read -r KEY; stty echo; echo;'
  + ' printf \'%s\' "$KEY" > ~/.config/commonly/anthropic-key)'
);
export const opencodeSnippet = ({ agentName, podId, model }: { agentName: string; podId: string; model?: string }): string => {
  const safeModel = model && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model) ? model : OPENCODE_DEFAULT_MODEL;
  const envFile = `~/.config/commonly/${agentName}.json`;
  return [
    'npm i -g @commonlyai/cli@latest opencode-ai',
    'commonly login',
    `cat > ${envFile} <<EOF`,
    `{"provider":{"id":"anthropic-compat","baseURL":"https://api.anthropic.com/v1","keyFile":"$HOME/.config/commonly/anthropic-key"},"model":"${safeModel}","sandbox":{"trust":"public"}}`,
    'EOF',
    `commonly agent attach opencode --pod ${podId} --name ${agentName} --env ${envFile}`,
    `commonly agent run ${agentName}`,
  ].join('\n');
};
// Harnesses that can't answer from this page today, and why in plain words.
// Every agent added here is a public one. dsh, pi and Hermes refuse a public
// seat outright. Qwen Code 0.26.2 and Goose 1.54.0 pass as public agents on
// CLI 0.1.242 (Growth walk 2026-11-04) but are set up from Terminal, not from
// this page yet; Goose 1.56 stays refused in open pods (#3430).
const REFUSED_HERE: Record<string, 'dsh' | 'qwen' | 'goose' | 'public'> = {
  dsh: 'dsh', qwen: 'qwen', pi: 'public', goose: 'goose', hermes: 'public',
};
const AGENT_KIND = 'agent' as const;
const HOSTED_STATUS_POLL_MS = 4000;
const HOSTED_STATUS_MAX_TICKS = 15;

type HostedAvailability = {
  configured: boolean;
  caps: { agentsPerUser: number; turnsPerDay: number };
};

// ADR-026 Phase 2: a machine registered by `commonly daemon register`. The
// heartbeat's per-agent states are what let this page WATCH the agent come up
// instead of ending on "now run this command".
type MachineRow = {
  id: string;
  machineId: string;
  name: string;
  createdAt?: string | null;
  status: 'online' | 'offline';
  agentStates?: { agentName: string; instanceId: string; state: string }[];
  // What the daemon found installed there (D247): marks and sorts the adapter list.
  runtimeInventory?: HarnessDeviceRow[];
  // D245: the daemon runs with no sandbox. Only a native Windows daemon reports
  // this (cli hostSandboxReport), and the CLI gives its seats no grant broker.
  hostUnconfined?: boolean;
};
const MACHINE_STATUS_POLL_MS = 4000;
const MACHINE_STATUS_MAX_TICKS = 30;
// Registration mints a machine-local credential, so it is inherently a terminal
// act — this page's job is to make it ONE paste (daemonSetupCommand), after
// which "On my computer" appears here.
const CLAUDE_FILE_NAME = 'CLAUDE.md';
// '' is auto-detect on that computer; anything else is a catalogue harness.
type MachineAdapter = string;

// Where the listener runs (cli 0.1.106 stops elsewhere, with directions):
// Commonly runs it in a sandbox. Seatbelt runs Claude Code and Codex on a Mac.
// On Linux (WSL included) bubblewrap runs Codex, and Claude Code only as a
// workspace seat, which the CLI allows only while every pod it answers in is
// invite-only (TASK-027); a public Claude Code seat there is refused. Native
// Windows has no sandbox for either, so there the listener runs unconfined and
// the page says so (D245). PowerShell has no `export`, so a Windows visitor
// gets PowerShell lines for both commands (windows-latest, 2026-10-16).
type SetupOs = 'mac' | 'linux' | 'windows';
const browserOs = (): SetupOs => {
  if (typeof navigator === 'undefined') return 'mac';
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || nav.userAgent || '';
  // Browser spellings only, case-sensitive: jsdom's user agent carries the
  // host's process.platform in lower case ("(linux)"), which must not flip the
  // page on a Linux CI host.
  // navigator.platform reads "Win32" on every Windows browser, 64-bit included.
  if (/Windows/.test(platform) || /^Win/.test(nav.platform || '')) return 'windows';
  if (/X11|CrOS|Linux (x86_64|aarch64|armv|i686)|^Linux$/.test(platform) && !/Android/.test(platform)) return 'linux';
  return 'mac';
};
// What the page saw, for the first-open mark only (byoOpenedOs). Unlike
// browserOs it does not default to mac: a browser it can't place is 'other'.
type OpenedOs = SetupOs | 'other';
const openedOs = (): OpenedOs => {
  if (typeof navigator === 'undefined') return 'other';
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || nav.userAgent || '';
  if (/iPhone|iPad|Android/.test(platform)) return 'other';
  // iPadOS Safari in desktop mode reports a Mac user agent; touch gives it away.
  if (/Mac|macOS/.test(platform)) return (nav.maxTouchPoints || 0) > 1 ? 'other' : 'mac';
  const os = browserOs();
  return os === 'mac' ? 'other' : os;
};
const SETUP_OS_OPTIONS: Array<{ os: SetupOs; labelKey: string }> = [
  { os: 'mac', labelKey: 'agentByo.listen.osMac' },
  { os: 'linux', labelKey: 'agentByo.listen.osLinux' },
  { os: 'windows', labelKey: 'agentByo.listen.osWindows' },
];
// Windows runs either CLI without a sandbox (D245): the command is PowerShell
// lines, and the page says beside it that nothing confines the agent there.
// Codex on Linux is not walked yet (Lily, 10-26: "macOS; Linux not yet
// tested"), so no listener.
// Claude Code on Linux runs in any pod since F96 (#3395): a public seat runs in
// the bubblewrap jail on the person's own login. Tested in CI with a stand-in
// model; no person's walk yet, and the reach note says so.
// A pod confirmed private (workspace-trust.js podIsConfirmedPrivate): both
// flags reported and false, and invite-only. A pod that omits a flag is not.
const podIsConfirmedPrivate = (pod?: V2Pod): boolean => (
  typeof pod?.publicRead === 'boolean'
  && typeof pod?.communityListed === 'boolean'
  && !pod.publicRead
  && !pod.communityListed
  && pod.joinPolicy === 'invite-only'
);
// How long a person may wait, MCP snippet copied and listener command not, before
// the page names the command they missed.
const MISSED_LISTENER_AFTER_MS = 3 * 60 * 1000;

// Claude Code and Codex keep the OS rules above. No other harness answers from
// the page's key (D247): OpenCode gets its own Mac lines, and the rest a plain
// line saying what works instead.
// Codex on Windows has no sandbox, so a public pod refuses it. Before a pod is
// known there's nothing to refuse yet, so only a pod that isn't private rules it
// out: `podPrivate` is undefined until then.
const listenerRunsOn = (os: SetupOs, adapter: string, podPrivate?: boolean): boolean => {
  if (adapter === 'claude') return true;
  if (adapter === 'codex') return os === 'mac' || (os === 'windows' && podPrivate !== false);
  // OpenCode has its own lines (opencodeSnippet); the rest can't answer here.
  return false;
};

const sanitizeAgentName = (raw: string): string => raw
  .toLowerCase()
  .replace(/[^a-z0-9-]/g, '-')
  .replace(/-+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 64);

const V2AgentBYO: React.FC = () => {
  const { t, i18n } = useTranslation();
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
      instanceId: sanitizeAgentName(params.get('instanceId') || 'default') || 'default',
      persona: sanitizeAgentName(params.get('persona') || ''),
      // ?mode=hosted comes from Scout's "Run it here" button: the person
      // already asked Commonly to host their agent.
      hosted: params.get('mode') === 'hosted',
      // ?from=card comes from an approved connect card: the person already
      // chose their own agent, its name and its pod. ?adapter= is the tool
      // they told the proposer they run.
      fromCard: params.get('from') === 'card',
      reconnect: params.get('reconnect') === '1',
      machine: params.get('mode') === 'machine',
      adapter: ((a): string | null => (a && KNOWN_HARNESS_IDS.includes(a) ? a : null))(params.get('adapter')),
    };
  })();
  // 2026-09-01: persona deep links carry context into this otherwise
  // machine-first entry. The page names the agent after the selected persona
  // and records that choice on the installation; no param says so plainly.
  const personaCard = PERSONA_CARDS.find((c) => c.key === prefill.persona) || null;
  const [pods, setPods] = useState<V2Pod[]>([]);
  const [podId, setPodId] = useState<string>(prefill.pod);
  // Personalized default: a global-namespace collision guard (#613) means a
  // shared literal default ("my-mcp-agent") 409s for every user after the
  // first one to accept it. Seed from the username so defaults never collide.
  const { currentUser } = useAuth();
  const userSlug = (currentUser?.username || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  // The default name follows where the agent runs (C14 rehearsal, 2026-10-20):
  // "Run it here" takes `<user>-agent`, so an own agent defaulting to the same
  // name was refused at the token step once the hosted one existed. Your own
  // agent defaults to `<user>-<claude|codex>`, a computer placement to
  // `<user>-<adapter|local>`. A name the person typed is never replaced.
  const defaultNameFor = (runMode: string | null, runner: string): string => {
    if (personaCard) return userSlug ? `${userSlug}-${personaCard.key}` : personaCard.key;
    if (!userSlug) return DEFAULT_AGENT_NAME;
    if (runMode === 'byo' || runMode === 'machine') return `${userSlug}-${runner || 'local'}`;
    return `${userSlug}-agent`;
  };
  const [name, setName] = useState<string>(prefill.name || defaultNameFor(null, ''));
  const [nameTouched, setNameTouched] = useState<boolean>(Boolean(prefill.name));
  const [namesReady, setNamesReady] = useState(false);
  const [nameLookupError, setNameLookupError] = useState(false);
  const [nameLookupRetry, setNameLookupRetry] = useState(0);
  const [pendingReplacement, setPendingReplacement] = useState<{ agentName: string; podId: string } | null>(null);
  // F164: the install route asks for a confirm when joining this pod would
  // confine the agent's writes elsewhere. A confirm only ever applies to the
  // name, pod and mode it was shown for.
  const [pendingNarrowing, setPendingNarrowing] = useState<{ agentName: string; narrowing: InstallNarrowing } | null>(null);
  const [existingConnection, setExistingConnection] = useState<{
    connection: AgentConnection; runtimeType: string; installedBy?: string;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<'machine' | 'name' | 'pod' | null>(null);
  const [issued, setIssued] = useState<{ token: string; agentName: string; podId: string; issuedAt: number } | null>(null);
  const [hasCopied, setHasCopied] = useState(false);
  const [showHostedOffer, setShowHostedOffer] = useState(false);
  const offeredPanels = useRef(new Set<string>());
  const offerSessionKey = issued
    ? `commonly:byo-hosted-offer:${currentUser?._id || ''}:${issued.podId}:${issued.agentName}`
    : null;
  const viewed = useRef(false);
  const commandViewed = useRef<object | null>(null);
  const fallbackStarting = useRef(false);
  const allocatedHosted = useRef<{ issued: object; name: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  // Which CLI the listener runs. Pinned in the command (`--adapter`), so a Mac
  // without Claude Code says so instead of quietly starting Codex (QA BYO
  // walk 1, 2026-10-16). Claude Code by default: it is what most people use.
  const [listenAdapter, setListenAdapter] = useState<string>(prefill.adapter || 'claude');
  // D247: every harness `agent run --adapter` accepts, from the server. The
  // two the page always offered stand in until it arrives.
  // Read fourth in the mount sequence below, once.
  const [harnessCatalog, setHarnessCatalog] = useState<HarnessCatalogEntry[]>(FALLBACK_HARNESSES);
  const catalogRequested = useRef(false);
  const listenTool = harnessLabel(harnessCatalog, listenAdapter);
  // Where the person sets up, defaulted from this browser. They can switch:
  // the machine they browse on is not always the one they set up.
  const [setupOs, setSetupOs] = useState<SetupOs>(browserOs);
  const repoPod = pods.find((p) => p._id === (issued?.podId || podId));
  const listenerAvailable = listenerRunsOn(setupOs, listenAdapter, repoPod ? podIsConfirmedPrivate(repoPod) : undefined);
  // TASK-705: "Work in my repo". The CLI already confines a seat to the folder it
  // starts in when every pod is confirmed private (workspace trust: Seatbelt on
  // a Mac, bwrap on Linux). This choice makes that explicit and carries the two
  // opt-ins. There is no unconfined path: write and web only ever ride on
  // `--allow`, and the CLI refuses them for a folder it will not confine.
  const [workInRepo, setWorkInRepo] = useState(false);
  const [allowWrite, setAllowWrite] = useState(false);
  const [allowWeb, setAllowWeb] = useState(false);
  // Each seat is its own opt-in: starting another install clears all three.
  useEffect(() => {
    setWorkInRepo(false); setAllowWrite(false); setAllowWeb(false);
  }, [issued?.token]);
  const repoChoiceAvailable = listenAdapter === 'claude'
    && setupOs !== 'windows'
    && podIsConfirmedPrivate(repoPod);
  const repoActive = workInRepo && repoChoiceAvailable;
  const allowFlag = repoActive
    ? [allowWrite && 'write', allowWeb && 'web'].filter(Boolean).join(',')
    : '';

  // Live listening verification (#887 class, second half). #888 made the
  // listening step legible; this makes it CHECKABLE — the page polls the
  // kernel until THIS agent's runtime token authenticates for the first time
  // after issuance, then flips the step to a checkmark. Without it, users
  // finish the page, mention the agent, and get silence with no way to know
  // which step they missed. 'waiting' → 'listening' | 'timeout'.
  const [listenState, setListenState] = useState<'waiting' | 'listening' | 'timeout'>('waiting');
  // Which command the person copied for THIS issue, and whether they have been
  // waiting long enough to say so. A stranger copied the MCP snippet three
  // times and never the Terminal command (walk 2026-10-31, TASK-721): the page
  // then names the one they missed instead of waiting in silence.
  const [copiedKinds, setCopiedKinds] = useState({ mcp: false, listen: false });
  const [missedWindowOver, setMissedWindowOver] = useState(false);
  // ADR-023 W2 "Run it here" — the zero-terminal path. Offered only when the
  // instance reports a configured hosted runtime, and the default there: the
  // stranger this page exists for has no runtime to bring. The kernel mints
  // the token and hands it to the runtime server-side; nothing secret is
  // ever rendered on this screen.
  const [hosting, setHosting] = useState<HostedAvailability | null>(null);
  // Where the agent runs is the person's choice, so nothing is preselected
  // when there is a choice to make (UX Lead's first-session artboards, frame
  // 04; ruled 2026-10-14). Preselecting "Run it here" answered a question this
  // page's own title never asks, and made every bare visit read as a choice of
  // hosting. A ?name= deep link comes from Scout's connect_local_agent card:
  // the person asked to connect THEIR OWN agent (e.g. Claude Code), so it
  // starts on "Bring your own runtime" (Growth's walk, 2026-10-14: one click
  // gave a hosted agent named after their Claude Code). A ?mode=hosted link
  // comes from Scout's hosted offer, where the person asked to be hosted, so
  // it starts on "Run it here".
  const [chosenMode, setMode] = useState<'hosted' | 'byo' | 'machine' | null>(() => {
    if (prefill.hosted) return 'hosted';
    if (prefill.machine) return 'machine';
    return prefill.name ? 'byo' : null;
  });
  const [hosted, setHosted] = useState<{ agentName: string; podId: string; ready?: boolean } | null>(null);
  // Walk 4 (2026-10-16): a stranger who arrived from a "Run it here" button
  // read 130 words (31s) before reaching it. They already chose hosting, so
  // the page shows only the act, where it lands and the limits; the full page
  // is one click away.
  const [compactHosted, setCompactHosted] = useState<boolean>(prefill.hosted);
  // QA BYO walk 2 (2026-10-16): from an approved card the page still asked
  // where it should run and showed the name and pod fields: 127 words before
  // the button, most of them re-asking what the card settled. From a card the
  // page shows the act and where it lands; the full page is one click away.
  // The key is still minted by the click, never on load: the click is consent.
  const [compactByo, setCompactByo] = useState<boolean>(prefill.fromCard && Boolean(prefill.name));
  // A card fixes the name, and the approval already installed under it, so the
  // runner belongs to the card too: no picker on a card. "Use a different
  // runner" from a card opens the plain page with nothing carried over.
  const [onCardStart, setOnCardStart] = useState<boolean>(prefill.fromCard);
  const [hostedState, setHostedState] = useState<'starting' | 'running' | 'slow'>('starting');
  // ADR-026 Phase 2: "on my computer" — install + placement request; the
  // daemon on the chosen machine adopts, provisions, and starts the agent.
  const [machines, setMachines] = useState<MachineRow[]>([]);
  // True once both the availability and the machines requests have answered,
  // successfully or not. Until then, whether there is a choice is unknown.
  const [choicesKnown, setChoicesKnown] = useState(false);
  const [machineId, setMachineId] = useState<string>('');
  // With no choice cards on screen (no hosting, no computer), bringing your
  // own runtime is the only path, so it is the mode. With cards, it is the
  // person's pick, and null until they make one. "Not known yet" counts as a
  // choice still to make: the pod list loads first and enables the act, so
  // treating an unanswered availability or machines request as "nothing to
  // choose" rendered an enabled Bring-your-own act before the cards (Sprint
  // Review on #2190). A failed or malformed reply still answers: once both
  // are in, a hosting reply that never arrived well-formed reads as "cannot
  // host", and the machines list as empty.
  const choosingMode = !choicesKnown || Boolean(hosting?.configured) || machines.length > 0;
  // "Run it here" counts only once the instance says it can host: a hosted
  // link must not arm a hosted install before, or without, that answer.
  const mode = chosenMode === 'hosted' && !hosting?.configured
    ? (choosingMode ? null : 'byo')
    : chosenMode ?? (choosingMode ? null : 'byo');
  // Shown from first paint for a hosted link (no flash of the full page while
  // availability loads); the act stays disabled until the instance says it can
  // host, and an instance that cannot falls back to the full page.
  const showCompactHosted = compactHosted && !personaCard && (mode === 'hosted' || !choicesKnown);
  // Compact only where the command exists (#2289): "One command in Terminal"
  // must not open onto a page that shows no command. Elsewhere the full page
  // says why and what works instead.
  const showCompactByo = compactByo && listenerAvailable && !showCompactHosted && !personaCard && mode === 'byo';
  const selectedMachine = machines.find((m) => m.machineId === machineId);
  const selectedMachineName = selectedMachine
    ? machineDisplayName(selectedMachine, machines, t, i18n.language)
    : machineId;
  // Model choice for the on-my-computer path. Adapter and model travel
  // together: a Codex model slug must never be left behind if the user flips
  // back to Claude or auto-detect, and vice versa.
  const [adapter, setAdapter] = useState<MachineAdapter>('');
  const [model, setModel] = useState<string>('');
  const [effort, setEffort] = useState<string>('');
  // A model or effort belongs to the harness it was picked for.
  useEffect(() => { setModel(''); setEffort(''); }, [mode, listenAdapter]);
  useEffect(() => { setPendingNarrowing(null); }, [name, podId, mode]);
  const machineInventory = selectedMachine?.runtimeInventory || [];
  const canReconnect = Boolean(existingConnection
    && (['revoked', 'stale'].includes(existingConnection.connection.state)
      || (prefill.reconnect && existingConnection.runtimeType === 'wrapper'))
    && (existingConnection.installedBy === String(currentUser?._id) || currentUser?.role === 'admin'));
  const isOtherOwner = Boolean(existingConnection && existingConnection.installedBy
    && existingConnection.installedBy !== String(currentUser?._id) && currentUser?.role !== 'admin');
  // The same roster verdict powers Your Team and this reconnection screen.
  // Limit the lookup to an intentional name to avoid probing suggested names.
  useEffect(() => {
    if (!podId || !nameTouched || !sanitizeAgentName(name)) {
      setExistingConnection(null);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api.get<{ agents?: Array<{ name: string; instanceId: string; runtime?: { runtimeType?: string }; connection?: AgentConnection; installedBy?: string }> }>(`/api/registry/pods/${encodeURIComponent(podId)}/agents`)
        .then((result) => {
          if (cancelled) return;
          const match = result.agents?.find((agent) => agent.name === sanitizeAgentName(name)
            && agent.instanceId === prefill.instanceId && agent.connection);
          setExistingConnection(match?.connection ? {
            connection: match.connection,
            runtimeType: match.runtime?.runtimeType || '',
            installedBy: match.installedBy,
          } : null);
        })
        .catch(() => { if (!cancelled) setExistingConnection(null); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [api, name, nameTouched, podId, prefill.instanceId, prefill.reconnect]);
  // Re-default while the person hasn't typed a name: when the user resolves
  // after mount, and when the mode or the runner changes.
  const defaultAgentName = defaultNameFor(mode, mode === 'machine' ? adapter : listenAdapter);
  useEffect(() => {
    if (!nameTouched) {
      setName(defaultAgentName);
      setNamesReady(false);
    }
  }, [defaultAgentName, nameTouched]);

  // A card's name is the lookup's base only while the card is on screen.
  // Once the person goes back to the start, the runner names the install.
  // Any other link keeps its ?name= prefill as before.
  const namePrefill = prefill.fromCard && !onCardStart ? '' : prefill.name;
  const lastSuggestedName = useRef<string | null>(null);
  useEffect(() => {
    if (!choicesKnown) return undefined;
    if (prefill.reconnect && prefill.name) {
      setNamesReady(true);
      return undefined;
    }
    let cancelled = false;
    const base = sanitizeAgentName(namePrefill || defaultAgentName);
    setNamesReady(false);
    setNameLookupError(false);
    // The pod lets the server hand back this person's own install there whose
    // key never arrived, instead of "<name>-2". BYO only: that install is a
    // webhook, so another mode handed its name would hit "already installed".
    // Not with a persona: its display name derives a non-default instance,
    // and the server only hands back installs on the default one.
    const inPod = mode === 'byo' && podId && !personaCard ? `&podId=${encodeURIComponent(podId)}` : '';
    api.get<{ name?: string }>(`/api/registry/agents/next-free-name?base=${encodeURIComponent(base)}${inPod}`)
      .then((result) => {
        if (cancelled) return;
        if (!result?.name) throw new Error('Empty name suggestion');
        // A name the page suggested earlier is still the page's to replace,
        // e.g. "<name>-2" before the person picked the pod holding <name>.
        // Read before the update: React runs the updater later.
        const previous = lastSuggestedName.current;
        lastSuggestedName.current = result.name;
        setName((current) => (
          !nameTouched || current === namePrefill || current === previous
            ? result.name! : current));
        setNamesReady(true);
      })
      .catch(() => { if (!cancelled) setNameLookupError(true); });
    return () => { cancelled = true; };
  }, [api, choicesKnown, defaultAgentName, mode, namePrefill, nameLookupRetry, nameTouched, personaCard, podId,
    prefill.reconnect, prefill.name]);
  const [placed, setPlaced] = useState<{ agentName: string; machineId: string; machineName: string } | null>(null);
  const [placedState, setPlacedState] = useState<'waiting' | 'running' | 'slow'>('waiting');
  const [reconnectRequest, setReconnectRequest] = useState<{
    agentName: string; requestedAt: string; state: 'waiting' | 'connected' | 'slow';
  } | null>(null);

  useEffect(() => {
    if (!reconnectRequest || reconnectRequest.state !== 'waiting' || !podId) return undefined;
    let cancelled = false;
    let ticks = 0;
    const check = async () => {
      ticks += 1;
      try {
        const roster = await api.get<{ agents?: Array<{ name: string; instanceId: string; connection?: AgentConnection }> }>(
          `/api/registry/pods/${encodeURIComponent(podId)}/agents`,
        );
        if (cancelled) return;
        const status = roster.agents?.find((agent) => agent.name === reconnectRequest.agentName
          && agent.instanceId === prefill.instanceId)?.connection;
        if (status?.state === 'connected' && status.lastSeenAt
          && Date.parse(status.lastSeenAt) >= Date.parse(reconnectRequest.requestedAt)) {
          setReconnectRequest((current) => current && { ...current, state: 'connected' });
          return;
        }
      } catch { /* a transient roster error does not erase the request */ }
      if (!cancelled && ticks >= MACHINE_STATUS_MAX_TICKS) {
        setReconnectRequest((current) => current && { ...current, state: 'slow' });
      }
    };
    void check();
    const timer = setInterval(() => { void check(); }, MACHINE_STATUS_POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [api, podId, prefill.instanceId, reconnectRequest]);

  // Watch the placement come up: the machine heartbeat carries per-agent
  // supervisor states, so "live" here means the daemon actually spawned it.
  useEffect(() => {
    if (!placed) return undefined;
    let cancelled = false;
    let ticks = 0;
    setPlacedState('waiting');
    const timer = setInterval(async () => {
      ticks += 1;
      try {
        const data = await api.get<{ machines?: MachineRow[] }>('/api/machines');
        if (cancelled) return;
        const machine = (data?.machines || []).find((m) => m.machineId === placed.machineId);
        const seat = machine?.agentStates?.find((s) => s.agentName === placed.agentName);
        if (seat?.state === 'running') {
          setPlacedState('running');
          clearInterval(timer);
          return;
        }
      } catch {
        // keep polling — a transient status failure is not a stopped daemon
      }
      if (ticks >= MACHINE_STATUS_MAX_TICKS) {
        setPlacedState('slow');
        clearInterval(timer);
      }
    }, MACHINE_STATUS_POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [api, placed]);

  // Same shape as the listening check below, against the runtime's own
  // status: the DO reports lastPollAt once its alarm loop has run, and the
  // native engine reports ready once provisioned (it has no loop to wait for).
  // ~60s cap, then honest copy — the agent still picks messages up when it starts.
  // QA walk 3 (2026-10-16): the first check waited a full interval, so for 4s
  // the panel said "is live" and "Starting…" at once. A provision that answers
  // ready (the native engine) is running now; otherwise check at once, then poll.
  useEffect(() => {
    if (!hosted) return undefined;
    if (hosted.ready) {
      setHostedState('running');
      return undefined;
    }
    let cancelled = false;
    let ticks = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    setHostedState('starting');
    const check = async () => {
      ticks += 1;
      try {
        const data = await api.get<{ runtime?: { lastPollAt?: number | null; ready?: boolean } }>(
          `/api/hosted/status?agentName=${encodeURIComponent(hosted.agentName)}`,
        );
        if (cancelled) return;
        if (data?.runtime?.ready === true || data?.runtime?.lastPollAt) {
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
    };
    timer = setInterval(check, HOSTED_STATUS_POLL_MS);
    void check();
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
          // Default to the person's own workspace (TASK-645 item 9): the
          // picker no longer jumps to the last pod they opened. Recent visits
          // only decide when they own no installable pod. Signup creates
          // My Workspace before anything the person makes, so the OLDEST
          // owned pod is that workspace; the name is not a reliable marker
          // (it can be renamed). V2Layout records visits when a pod opens; a
          // stale visit to a public pod cannot select it because the list
          // above already excludes publicRead pods.
          const uid = currentUser?._id;
          const owned = uid
            ? installablePods.filter((p) => p.createdBy?._id && String(p.createdBy._id) === String(uid))
            : [];
          const createdMs = (p: V2Pod) => (p.createdAt ? Date.parse(p.createdAt) : Number.POSITIVE_INFINITY);
          const own = owned.sort((a, b) => createdMs(a) - createdMs(b))[0];
          const visits = readPodVisits();
          const recent = installablePods
            .filter((p) => visits[p._id] > 0)
            .sort((a, b) => visits[b._id] - visits[a._id])[0];
          setPodId((own || recent || installablePods[0])._id);
        }
      } catch {
        // Defensive: keep the form usable; user will see the error on submit.
      }
      try {
        // This request also records the person's first visit to this page on
        // the server (User.onboarding.byoOpenedAt, and byoOpenedOs from ?os).
        // Keep it on page load.
        const availability = await api.get<HostedAvailability>(`/api/hosted/availability?os=${openedOs()}`);
        if (cancelled) return;
        if (availability && typeof availability.configured === 'boolean') {
          // Sets no mode. This effect re-runs on every pod change (podId is a
          // dep), and when it once re-asserted a default it silently stomped
          // an explicit choice — caught live 2026-09-06: pick "On my
          // computer", pick a pod, and the submit button turned back into
          // "Run it here".
          setHosting(availability);
        }
      } catch {
        if (!cancelled) setHosting({ configured: false, caps: { agentsPerUser: 0, turnsPerDay: 0 } });
      }
      // Third by design — the mode cards degrade gracefully without it.
      try {
        const machineList = await api.get<{ machines?: MachineRow[] }>('/api/machines');
        if (cancelled) return;
        if (Array.isArray(machineList?.machines) && machineList.machines.length > 0) {
          setMachines(machineList.machines);
          setMachineId((prev) => prev || defaultMachine(machineList.machines)?.machineId || '');
        }
      } catch {
        // No daemon machines — the "on my computer" card simply doesn't show.
      }
      // Fourth, and once: the page works on the two-harness fallback until
      // the full list arrives (D247).
      if (!catalogRequested.current) {
        catalogRequested.current = true;
        try {
          const catalog = await api.get<{ harnesses?: HarnessCatalogEntry[] }>('/api/registry/harness-catalog');
          const rows = Array.isArray(catalog?.harnesses)
            ? catalog.harnesses.filter((row) => row && typeof row.id === 'string') : [];
          if (rows.length) setHarnessCatalog(rows);
        } catch {
          catalogRequested.current = false;
        }
      }
      if (!cancelled) setChoicesKnown(true);
    })();
    return () => { cancelled = true; };
  }, [api, podId, currentUser?._id]);

  // Live preview rail — you see the agent you are about to create. The
  // avatar is the same character render the pod will show (seeded by
  // name:instanceId, so the preview face IS the final face), which is what
  // turns this page from a form into a decision about a teammate.
  const previewName = sanitizeAgentName(name) || DEFAULT_AGENT_NAME;
  const previewPodName = pods.find((p) => p._id === (hosted?.podId || issued?.podId || podId))?.name || '';
  const previewStatus: 'draft' | 'waiting' | 'starting' | 'live' = (() => {
    if (hosted) return hostedState === 'running' ? 'live' : 'starting';
    if (placed) return placedState === 'running' ? 'live' : 'starting';
    // A token has been issued and the agent has not checked in yet. That is not
    // 'draft' — the install succeeded, and the page says so beside this rail.
    // A timeout reads the same way: still waiting, not un-created.
    if (!issued) return 'draft';
    return listenState === 'listening' ? 'live' : 'waiting';
  })();
  const previewDisplayName = hosted?.agentName || placed?.agentName || issued?.agentName || previewName;

  // Hosted path: install with runtimeType 'hosted' (the kernel's cap gate
  // answers 403 hosted_cap_reached), then ask the kernel to provision. No
  // token round-trips through the browser.
  const submitHosted = async (cleanName: string, confirmNarrowing = false) => {
    setSubmitting(true);
    try {
      try {
        await api.post('/api/registry/install', {
          agentName: cleanName,
          podId,
          scopes: DEFAULT_INSTALL_SCOPES,
          config: { runtime: { runtimeType: 'hosted' }, ...(personaCard ? { persona: personaCard.key } : {}) },
          displayName: personaCard?.name || cleanName,
          // #1649: the seat carries the persona's own sentence, so Your Team never shows a placeholder.
          ...(personaCard ? { description: personaCard.card } : {}),
          ...(confirmNarrowing ? { confirmNarrowing: true } : {}),
        });
      } catch (installErr) {
        const narrowing = installNarrowingFromError(installErr);
        if (narrowing) {
          setPendingNarrowing({ agentName: cleanName, narrowing });
          return false;
        }
        const data = (installErr as { response?: { data?: { error?: string; code?: string; cap?: number; holders?: Array<{ agentName?: string }> } } })
          ?.response?.data;
        if (data?.code === 'hosted_cap_reached') {
          setError(hostedCapNotice(t, data, hosting?.caps.agentsPerUser));
          return;
        }
        if (!/already installed/i.test(data?.error || '')) throw installErr;
      }
      const provisioned = await api.post<{ ready?: boolean }>('/api/hosted/provision', { agentName: cleanName });
      setHosted({ agentName: cleanName, podId, ready: provisioned?.ready === true });
      return true;
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

  const startHostedInstead = async () => {
    if (!issued || submitting || fallbackStarting.current) return;
    fallbackStarting.current = true;
    recordByoStep(api, 'hosted-offer-clicked');
    setSubmitting(true);
    setError(null);
    try {
      // A BYO installation cannot be provisioned as hosted. Allocate a new
      // identity through the same server name allocator as the setup form.
      if (allocatedHosted.current?.issued !== issued) {
        const base = userSlug ? `${userSlug}-agent` : 'hosted-agent';
        const available = await api.get<{ name: string }>(
          `/api/registry/agents/next-free-name?base=${encodeURIComponent(base)}`,
        );
        if (!available.name || available.name === issued.agentName) {
          throw new Error(t('agentByo.errors.nameLookupFailed'));
        }
        allocatedHosted.current = { issued, name: available.name };
      }
      // An install can succeed while provision fails. Reuse its name on retry
      // so the existing-installation path can finish within the hosted cap.
      if (await submitHosted(allocatedHosted.current.name)) setIssued(null);
    } catch {
      setError(t('agentByo.errors.nameLookupFailed'));
    } finally {
      fallbackStarting.current = false;
      setSubmitting(false);
    }
  };

  // On-my-computer path (ADR-026 Phase 2): install with runtimeType 'wrapper'
  // + persona, then file the placement request. The daemon on that machine
  // adopts (D3 CAS), mints the credential server-side (nothing secret renders
  // here either), and starts the agent — the page watches it come up.
  const submitMachine = async (cleanName: string, confirmNarrowing = false) => {
    if (!machineId) {
      setErrorField('machine');
      setError(t('agentByo.errors.machineRequired'));
      return;
    }
    setSubmitting(true);
    try {
      try {
        await api.post('/api/registry/install', {
          agentName: cleanName,
          instanceId: 'default',
          podId,
          scopes: DEFAULT_INSTALL_SCOPES,
          config: {
            runtime: {
              runtimeType: 'wrapper',
              ...(adapter ? { adapter } : {}),
              ...(adapter && model.trim() ? { model: model.trim() } : {}),
              ...(adapter && effort ? { effort } : {}),
            },
            ...(personaCard ? { persona: personaCard.key } : {}),
          },
          displayName: personaCard?.name || cleanName,
          // #1649: the seat carries the persona's own sentence, so Your Team never shows a placeholder.
          ...(personaCard ? { description: personaCard.card } : {}),
          ...(confirmNarrowing ? { confirmNarrowing: true } : {}),
        });
      } catch (installErr) {
        const narrowing = installNarrowingFromError(installErr);
        if (narrowing) {
          setPendingNarrowing({ agentName: cleanName, narrowing });
          return;
        }
        // Same identity-continuity tolerance as the BYO path below.
        const msg = (installErr as { response?: { data?: { error?: string } } })
          ?.response?.data?.error || '';
        if (!/already installed/i.test(msg)) throw installErr;
      }
      await api.post('/api/agent-binding/request', {
        agentName: cleanName, instanceId: 'default', machineId,
      });
      setPlaced({
        agentName: cleanName,
        machineId,
        machineName: selectedMachineName,
      });
    } catch (err) {
      const e = err as { response?: { data?: { error?: string; message?: string; code?: string } }; message?: string };
      // Defensive: neither route this path calls returns the in-process code
      // today (sprint-review on #2365). It reads right the day one does.
      setError(e.response?.data?.code === IN_PROCESS_NAME_CODE
        ? t('agentByo.errors.nameIsHosted', { name: cleanName })
        : e.response?.data?.message || e.response?.data?.error || e.message || t('agentByo.errors.installFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const requestMachineReconnect = async (cleanName: string) => {
    setSubmitting(true);
    setError(null);
    try {
      const response = await api.post<{ requestedAt: string }>('/api/agent-binding/reconnect', {
        agentName: cleanName, instanceId: prefill.instanceId,
      });
      setReconnectRequest({ agentName: cleanName, requestedAt: response.requestedAt, state: 'waiting' });
    } catch (err) {
      const e = err as { response?: { data?: { code?: string; message?: string } }; message?: string };
      setError(e.response?.data?.code === 'machine_key_revoked'
        ? t('agentConnection.machineKeyRevoked')
        : e.response?.data?.message || e.message || t('agentByo.errors.installFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const submit = async (confirmNarrowing = false) => {
    setError(null);
    setErrorField(null);
    setPendingReplacement(null);
    setPendingNarrowing(null);
    const cleanName = sanitizeAgentName(name);
    if (!cleanName) {
      setErrorField('name');
      setError(t('agentByo.errors.nameRequired'));
      return;
    }
    if (!podId) {
      setErrorField('pod');
      setError(t('agentByo.errors.podRequired'));
      return;
    }
    if (!mode) return;
    if (mode === 'hosted') {
      await submitHosted(cleanName, confirmNarrowing);
      return;
    }
    if (mode === 'machine') {
      await submitMachine(cleanName, confirmNarrowing);
      return;
    }
    setSubmitting(true);
    try {
      // "Already installed" is the lost-token recovery path. The issue below
      // never revokes a running key: an agent that holds one answers
      // existing:true and the page asks for an explicit replacement. One that
      // never got its key (an earlier click's issue failed or was abandoned)
      // gets it now, instead of a second install under "<name>-2".
      try {
        await api.post('/api/registry/install', {
          agentName: cleanName,
          podId,
          scopes: DEFAULT_INSTALL_SCOPES,
          // D247: the runner, model and effort travel with the agent, so
          // Settings shows them and the listener reads them before each turn.
          // Any adapter besides Claude Code and Codex must be declared here, or
          // `agent run` refuses to start it.
          config: { runtime: { runtimeType: 'webhook', adapter: listenAdapter,
            ...(model.trim() ? { model: model.trim() } : {}), ...(effort ? { effort } : {}) },
          ...(personaCard ? { persona: personaCard.key } : {}) },
          displayName: personaCard?.name || cleanName,
          // #1649: the seat carries the persona's own sentence, so Your Team never shows a placeholder.
          ...(personaCard ? { description: personaCard.card } : {}),
          ...(confirmNarrowing ? { confirmNarrowing: true } : {}),
        });
      } catch (installErr) {
        const narrowing = installNarrowingFromError(installErr);
        if (narrowing) {
          setPendingNarrowing({ agentName: cleanName, narrowing });
          return;
        }
        const msg = (installErr as { response?: { data?: { error?: string } } })
          ?.response?.data?.error || '';
        if (!/already installed/i.test(msg)) throw installErr;
      }
      // An agent can have a token from another pod. A nonrotating issue
      // returns existing:true in that case, so no key is revoked here.
      const tokenRes = await api.post<{ token?: string; existing?: boolean }>(
        `/api/registry/pods/${encodeURIComponent(podId)}/agents/${encodeURIComponent(cleanName)}/runtime-tokens`,
        { label: 'BYO MCP — initial issue' },
      );
      if (tokenRes?.existing) {
        setPendingReplacement({ agentName: cleanName, podId });
        return;
      }
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
      const e = err as { response?: { data?: { error?: string; message?: string; code?: string } }; message?: string };
      setError(e.response?.data?.code === IN_PROCESS_NAME_CODE
        ? t('agentByo.errors.nameIsHosted', { name: cleanName })
        : e.response?.data?.error || e.response?.data?.message || e.message || t('agentByo.errors.installFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const replaceRunningKey = async (target = pendingReplacement) => {
    if (!target) return;
    setSubmitting(true);
    setError(null);
    try {
      const { agentName, podId: targetPodId } = target;
      const tokenRes = await api.post<{ token?: string }>(
        `/api/registry/pods/${encodeURIComponent(targetPodId)}/agents/${encodeURIComponent(agentName)}/runtime-tokens`,
        { label: 'BYO MCP — replacement', force: true, instanceId: prefill.instanceId },
      );
      if (!tokenRes?.token) {
        setError(t('agentByo.errors.tokenEmpty'));
        return;
      }
      setIssued({ token: tokenRes.token, agentName, podId: targetPodId, issuedAt: Date.now() });
      setListenState('waiting');
      setMemoryText('');
      setMemoryDone(false);
      setMemoryError(null);
      setPendingReplacement(null);
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

  // A new issue starts a new copy record and a new clock. Three minutes is long
  // enough to run a pasted command; the server nudge in the room waits longer.
  useEffect(() => {
    setCopiedKinds({ mcp: false, listen: false });
    setMissedWindowOver(false);
    if (!issued) return undefined;
    const timer = setTimeout(() => setMissedWindowOver(true), MISSED_LISTENER_AFTER_MS);
    return () => clearTimeout(timer);
  }, [issued?.issuedAt]);

  // Poll the kernel for THIS agent's first listener check-in after
  // issuance (an events poll or socket connect, not a tool call).
  // `/api/users/me/agent-connection` reports the caller's latest
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
  // Every step carries the setup the page is showing (OS and listener
  // eligibility) so the server can tell "listener was possible" from "not".
  const byoStep = (step: ByoStep, copyType?: ByoCopyType) => {
    recordByoStep(api, step, { setupOs, listenerAvailable, ...(copyType ? { copyType } : {}) });
  };

  useEffect(() => {
    if (!currentUser || viewed.current) return;
    viewed.current = true;
    recordByoStep(api, 'page-viewed');
  }, [api, currentUser]);

  // "Run it here" is on screen from first paint whenever the instance hosts
  // (the chooser, or the compact hosted form), so its exposure is counted
  // here, once per page view. The post-issue fallback below counts a separate,
  // later exposure. The compact BYO form has no hosted button, so it is out.
  const hostedOfferOnScreen = Boolean(hosting?.configured) && !issued && !hosted && !placed
    && !reconnectRequest && !showCompactByo;
  const hostedShownCounted = useRef(false);
  useEffect(() => {
    if (!hostedOfferOnScreen || hostedShownCounted.current) return;
    hostedShownCounted.current = true;
    recordByoStep(api, 'hosted-offer-shown');
  }, [api, hostedOfferOnScreen]);

  useEffect(() => {
    if (commandViewed.current === issued) return;
    commandViewed.current = issued;
    allocatedHosted.current = null;
    setHasCopied(false);
    setShowHostedOffer(false);
    if (!issued) return;
    // This event means the issued command rendered, distinct from page entry.
    // It also carries the setup the result page shows (TASK-714).
    recordByoStep(api, 'seat-created', { setupOs, listenerAvailable });
  }, [api, issued, setupOs, listenerAvailable]);

  const rememberHostedOffer = () => {
    if (!offerSessionKey) return;
    offeredPanels.current.add(offerSessionKey);
    try { sessionStorage.setItem(offerSessionKey, 'seen'); } catch { /* Storage can be disabled. */ }
  };

  useEffect(() => {
    if (!issued || !offerSessionKey || hasCopied || !hosting?.configured || listenState === 'listening') return undefined;
    const offer = () => {
      if (offeredPanels.current.has(offerSessionKey)) return;
      try { if (sessionStorage.getItem(offerSessionKey)) return; } catch { /* Use the panel guard. */ }
      offeredPanels.current.add(offerSessionKey);
      try { sessionStorage.setItem(offerSessionKey, 'seen'); } catch { /* Use the panel guard. */ }
      setShowHostedOffer(true);
      recordByoStep(api, 'hosted-offer-shown');
    };
    const timer = window.setTimeout(offer, 30_000);
    const leaving = (event: MouseEvent) => {
      if (event.clientY <= 0 && window.matchMedia('(min-width: 761px)').matches) offer();
    };
    document.documentElement.addEventListener('mouseleave', leaving);
    return () => {
      window.clearTimeout(timer);
      document.documentElement.removeEventListener('mouseleave', leaving);
    };
  }, [api, issued, offerSessionKey, hasCopied, hosting?.configured, listenState]);

  const markCopiedKind = (kind: 'mcp' | 'listen') => {
    setCopiedKinds((prev) => (prev[kind] ? prev : { ...prev, [kind]: true }));
  };

  const copiedIssuedContent = () => {
    rememberHostedOffer();
    setHasCopied(true);
    setShowHostedOffer(false);
  };

  const copy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      copiedIssuedContent();
      if (key === 'claude' || key === 'cursor') markCopiedKind('mcp');
      else if (key === 'listen') markCopiedKind('listen');
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
      if (key === 'claude') byoStep('mcp-command-copied', 'mcp-claude');
      else if (key === 'cursor') byoStep('mcp-command-copied', 'mcp-cursor');
      else if (key === 'listen') byoStep('cli-command-copied', 'listen');
      else if (key === 'daemon-setup') byoStep('daemon-command-copied', 'daemon');
      else if (key === 'tok') byoStep('token-copied', 'token');
    } catch {
      // Clipboard may be unavailable (non-HTTPS, sandbox); user can select manually.
    }
  };

  const chooseMode = (nextMode: 'hosted' | 'byo' | 'machine') => {
    if (nextMode === 'hosted') recordByoStep(api, 'hosted-offer-clicked');
    setMode(nextMode);
  };

  const apiUrl = getApiBaseUrl().replace(/\/+$/, '');
  // Windows PowerShell 5.1, the one every Windows ships, has no `&&`: the same
  // steps go one per line there, and each runs after the one before. The
  // install takes --unsandboxed there, as `agent run` does.
  const daemonCommand = setupOs === 'windows'
    ? `${daemonSetupCommand(apiUrl).split(' && ').join('\n')} --unsandboxed`
    : daemonSetupCommand(apiUrl);

  const claudeSnippet = issued
    ? `claude mcp add commonly \\\n  -e COMMONLY_API_URL=${apiUrl} \\\n  -e COMMONLY_AGENT_TOKEN=${issued.token} \\\n  -- npx -y @commonlyai/mcp`
    : '';
  // PowerShell has no `\` continuation, and Claude Code on Windows cannot
  // start an npm `.cmd` shim directly, so it goes through `cmd /c`. The server
  // is installed first: started through npx on a fresh machine, it was still
  // downloading when Claude Code gave up at 30 s (windows-latest, 2026-10-16).
  // The -e flags come after the command, with no `--`: PowerShell drops a bare
  // `--` on its way through npm's claude.ps1 shim, and -e then took the command
  // as one more value ("missing required argument 'commandOrUrl'",
  // windows-latest, 2026-11-04). mcp-windows.yml runs this exact line.
  const claudeSnippetWindows = issued
    ? `npm i -g @commonlyai/mcp\nclaude mcp add commonly cmd /c commonly-mcp -e COMMONLY_API_URL=${apiUrl} -e COMMONLY_AGENT_TOKEN=${issued.token}`
    : '';

  // The command that makes the agent LISTEN. Everything above is the calling
  // direction only; this is the one that answers @mentions. The CLI-install
  // line rides INSIDE the snippet: it used to live in a footnote on the
  // previous screen, so first-time users hit "command not found" one step
  // after we stopped watching (#887 class). It has to be an EXECUTABLE line,
  // and the snippet carries no `#` at all: until 2026-10-09 line 1 was
  // `# install …: npm i -g …`, so a whole-snippet paste skipped the install
  // (sprint-review on #2102); the first fix kept a trailing `# comment`, and
  // stock interactive zsh (the macOS default, `interactivecomments` off)
  // passes those words to npm as arguments, which exits with
  // EINVALIDTAGNAME "#" and installs nothing (ux-lead on #2104). The command
  // names itself; the body above the box says where to run it.
  const listenSnippet = issued
    ? connectSnippet({
      os: setupOs === 'windows' ? 'windows' : 'unix',
      apiUrl,
      token: issued.token,
      agentName: issued.agentName,
      adapter: listenAdapter,
      allow: allowFlag,
    })
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
  const cursorInstallHref = cursorMcpInstallLink(apiUrl);

  // The runner is picked before the install and never after it: the name
  // follows the runner, so a switch after issue would leave a claude-named
  // install under a codex listener. Going back to the start is the way to change it.
  const backToStart = () => {
    if (onCardStart) {
      setOnCardStart(false);
      setCompactByo(false);
      setName(defaultNameFor('byo', listenAdapter));
      setNameTouched(false);
    }
    setIssued(null);
  };
  // The daemon block lives in Other ways to connect on both the start form and
  // the result page, so the stop-on-close line can point to it from the result.
  // On Windows `daemon install` registers a logon task (D245).
  const addComputerBlock = machines.length === 0 ? (
    <div className="v2-byo__add-computer" data-testid="byo-add-computer">
      <span className="v2-byo__label">{t('agentByo.addComputer.title')}</span>
      <p className="v2-byo__hint" data-testid="byo-add-computer-recommended">{t('agentByo.addComputer.recommended')}</p>
      <div className="v2-byo__add-computer-row">
        <code className={setupOs === 'windows' ? 'v2-byo__add-computer-lines' : undefined}>{daemonCommand}</code>
        <button
          type="button"
          className="v2-byo__copy"
          onClick={() => copy('daemon-setup', daemonCommand)}
        >
          {copied === 'daemon-setup' ? t('agentByo.addComputer.copied') : t('agentByo.addComputer.copy')}
        </button>
      </div>
      {setupOs === 'windows' && (
        <p className="v2-byo__hint" data-testid="byo-add-computer-windows">
          <Trans i18nKey="agentByo.addComputer.windowsNote" components={{ cmd: <code /> }} />
        </p>
      )}
      <p className="v2-byo__hint">{t('agentByo.addComputer.after')}</p>
    </div>
  ) : null;
  // D247: a runner other than Claude Code and Codex takes the place of the
  // install button with what works for it. OpenCode gets its own Mac lines;
  // the rest a plain line naming what can answer instead.
  const hostedName = t('agentByo.mode.hosted');
  const refusedLine = (harness: string) => {
    const reason = REFUSED_HERE[harness] || 'public';
    const values = { tool: harnessLabel(harnessCatalog, harness), hosted: hostedName };
    if (reason === 'dsh') return t('agentByo.refused.dsh', values);
    if (reason === 'qwen') return t('agentByo.refused.qwen', values);
    if (reason === 'goose') return t('agentByo.refused.goose', values);
    return t('agentByo.refused.public', values);
  };
  // F175a: a harness that can't take a connector says so rather than leaving it
  // unmentioned: no sandbox (dsh, Hermes, and pi off macOS), not on the grant
  // list yet, pi's public-on-a-Mac rule (F175c), Qwen and Goose's public rule
  // (F175d), or a grant harness on native Windows, where the CLI withholds the
  // broker. `os` is null where the page doesn't know the computer's platform.
  const connectorLine = (harness: string, os: SetupOs | null) => {
    const block = connectorGrantBlock(harness, os);
    if (!block) return null;
    const tool = harnessLabel(harnessCatalog, harness);
    const text = {
      never: () => t('harness.noConnectors', { tool }),
      windows: () => t('harness.noConnectorsWindows'),
      macPublicOnly: () => t('harness.connectorsMacPublicOnly', { tool }),
      publicOnly: () => t('harness.connectorsPublicOnly', { tool }),
      notYet: () => t('harness.noConnectorsYet', { tool }),
    }[block]();
    return <p className="v2-byo__hint" data-testid="byo-no-connectors">{text}</p>;
  };
  const opencodeName = sanitizeAgentName(name) || DEFAULT_AGENT_NAME;
  const opencodeLines = podId ? opencodeSnippet({ agentName: opencodeName, podId, model: model.trim() }) : '';
  const byoAlternative = mode === 'byo' && listenAdapter !== 'claude' && listenAdapter !== 'codex' ? (
    listenAdapter !== 'opencode' ? (
      <>
        <p className="v2-byo__needs" data-testid="byo-runner-refused">{refusedLine(listenAdapter)}</p>
        {connectorLine(listenAdapter, setupOs)}
      </>
    ) : setupOs !== 'mac' ? (
      <p className="v2-byo__needs" data-testid="byo-opencode-unavailable">
        {t('agentByo.listen.unavailableOther', {
          tool: listenTool, os: t(SETUP_OS_OPTIONS.find((o) => o.os === setupOs)?.labelKey || 'agentByo.listen.osMac'),
        })}
      </p>
    ) : (
      <div className="v2-byo__opencode" data-testid="byo-opencode">
        <p className="v2-byo__needs">{t('agentByo.opencode.keyStep')}</p>
        <div className="v2-byo__command">
          <pre className="v2-byo__pre" data-testid="byo-opencode-key">{opencodeKeySnippet()}</pre>
          <button type="button" className="v2-byo__copy" onClick={() => copy('opencode-key', opencodeKeySnippet())}>
            {copied === 'opencode-key' ? t('agentByo.actions.copied') : t('agentByo.actions.copy')}
          </button>
        </div>
        <p className="v2-byo__needs">{t('agentByo.opencode.runStep', { name: opencodeName })}</p>
        {opencodeLines && (
          <div className="v2-byo__command">
            <pre className="v2-byo__pre" data-testid="byo-opencode-lines">{opencodeLines}</pre>
            <button type="button" className="v2-byo__copy" onClick={() => copy('opencode', opencodeLines)}>
              {copied === 'opencode' ? t('agentByo.actions.copied') : t('agentByo.actions.copy')}
            </button>
          </div>
        )}
        <p className="v2-byo__hint">
          {t('agentByo.opencode.provider')}{' '}
          <a className="v2-byo__link" href="https://github.com/Team-Commonly/commonly/blob/main/docs/cli/opencode.md" target="_blank" rel="noopener noreferrer">{t('agentByo.opencode.guide')}</a>
        </p>
      </div>
    )
  ) : null;
  const machineBlocked = mode === 'machine' && (Boolean(REFUSED_HERE[adapter]) || adapter === 'opencode');
  const runnerPicker = mode === 'byo' && !issued && !onCardStart ? (
    // A segment (d215 frame) under a visible label: the frame doesn't draw this
    // picker, so it keeps the "Adapter" label the page always showed.
    <>
    <p className="v2-byo__modes-question" id="byo-runner-label">{t('agentByo.form.adapterLabel')}</p>
    <p className="v2-byo__os" data-testid="byo-runner" role="group" aria-labelledby="byo-runner-label">
      {orderHarnessIds(harnessCatalog).map((runner) => (
        <button
          key={runner}
          type="button"
          className="v2-byo__link"
          aria-pressed={listenAdapter === runner}
          data-testid={`byo-runner-${runner}`}
          disabled={submitting}
          // The name follows the runner, so a key prompt for the old name is stale.
          onClick={() => { setPendingReplacement(null); setListenAdapter(runner); }}
        >
          {harnessLabel(harnessCatalog, runner)}
        </button>
      ))}
    </p>
    <V2HarnessChoice
      key={`byo:${listenAdapter}`}
      catalog={harnessCatalog}
      harness={listenAdapter}
      model={model}
      effort={effort}
      onModel={setModel}
      onEffort={setEffort}
    />
    </>
  ) : null;

  return (
    <V2FeaturePage
      title={(() => {
        if (showCompactHosted && !hosted) return t('agentByo.compact.title');
        // The command page keeps the tool's name (QA BYO walk 3: it reverted to
        // "Bring your own agent" after the click). A persona hire keeps the
        // page's own title: what it names is the persona, not the tool.
        if ((showCompactByo || issued) && !personaCard) {
          if (listenAdapter === 'codex') return t('agentByo.compactByo.titleCodex');
          if (listenAdapter === 'claude') return t('agentByo.compactByo.titleClaude');
          return t('agentByo.compactByo.titleOther', { tool: listenTool });
        }
        return t('agentByo.title');
      })()}
      // d215 s-byo draws the page's lead as the head's "i" hint, at 1440 and 390.
      hint={(() => {
        if (issued) return undefined;
        if (showCompactHosted && !hosted && hosting?.configured) return t('agentByo.compact.lead',{ agents: hosting?.caps.agentsPerUser, turns: hosting?.caps.turnsPerDay });
        if (showCompactByo) return t(setupOs === 'windows' ? 'agentByo.compactByo.leadWindows' : 'agentByo.compactByo.lead');
        return t('agentByo.description');
      })()}
      // d215 s-byo 390: the phone head leads with a back key to Your team; the
      // 1440 head has none, so the key is hidden above 760.
      lead={(
        <button
          type="button"
          className="v2-byo__back"
          aria-label={t('yourTeam.title')}
          title={t('yourTeam.title')}
          onClick={() => navigate('/v2/agents')}
          data-testid="byo-back"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
        </button>
      )}
      showPodsSidebar={false}
      className="v2-feature--byo"
    >
      <div className="v2-byo__layout">
      <div className="v2-byo__main">
      {!issued && !hosted && personaCard && (
        <div className="v2-byo__persona" data-testid="byo-persona-context">
          <V2Avatar name={personaCard.name} size="md" kind={AGENT_KIND} seed={personaCard.avatarSeed} />
          <div className="v2-byo__persona-body">
            <div className="v2-byo__persona-title">
              {t('agentByo.persona.hiring')} <strong>{personaCard.name}</strong> · {personaCard.role}
            </div>
            <div className="v2-byo__persona-line">{personaCard.oneLiner}</div>
          </div>
        </div>
      )}
      {showCompactHosted && !issued && !hosted && !placed && (
        <div className="v2-byo__form" data-testid="byo-hosted-compact">
          {/* Each line waits for its own data: no "joins  as" or "0 turns" on first paint. */}
          {pods.some((p) => p._id === podId) && (
            <p className="v2-byo__hint">
              {t('agentByo.compact.joins', {
                name: sanitizeAgentName(name) || DEFAULT_AGENT_NAME,
                pod: pods.find((p) => p._id === podId)?.name || '',
              })}
              {' '}
              <button type="button" className="v2-byo__link" onClick={() => setCompactHosted(false)}>
                {t('agentByo.compact.change')}
              </button>
            </p>
          )}
          {error && <div className="v2-byo__error">{error}</div>}
          <button
            type="button"
            onClick={() => {
              recordByoStep(api, 'hosted-offer-clicked');
              void submit();
            }}
            disabled={submitting || !podId || mode !== 'hosted'}
            className="v2-byo__submit"
          >
            {submitting ? t('agentByo.actions.starting') : t('agentByo.actions.runHere')}
          </button>
          <button
            type="button"
            className="v2-byo__link"
            data-testid="byo-other-ways"
            onClick={() => setCompactHosted(false)}
          >
            {t('agentByo.compact.otherWays')}
          </button>
        </div>
      )}
      {showCompactByo && !issued && !hosted && !placed && !reconnectRequest && (
        <div className="v2-byo__form" data-testid="byo-card-compact">
          {pods.some((p) => p._id === podId) && (
            <p className="v2-byo__hint">
              {t('agentByo.compact.joins', {
                name: sanitizeAgentName(name) || DEFAULT_AGENT_NAME,
                pod: pods.find((p) => p._id === podId)?.name || '',
              })}
              {' '}
              <button type="button" className="v2-byo__link" onClick={() => setCompactByo(false)}>
                {t('agentByo.compact.change')}
              </button>
            </p>
          )}
          {error && <div className="v2-byo__error">{error}</div>}
          {existingConnection && (
            <div className="v2-byo__hint" data-testid="byo-connection-state">
              {connectionLabel(existingConnection.connection, t)}
            </div>
          )}
          {nameLookupError && mode === 'byo' && <div className="v2-byo__error">{t('agentByo.errors.nameLookupFailed')} <button type="button" className="v2-byo__link" onClick={() => setNameLookupRetry((n) => n + 1)}>{t('agentByo.actions.retry')}</button></div>}
          {/* Enabled once the pod list confirms the pod: a link's pod the person
              cannot install into is replaced by their own, and that is the line
              above the button, so the click never lands somewhere unshown. */}
          {runnerPicker}
          {!isOtherOwner && <button
            type="button"
            onClick={() => {
              if (canReconnect) {
                if (existingConnection?.runtimeType === 'wrapper') void requestMachineReconnect(sanitizeAgentName(name));
                else void replaceRunningKey({ agentName: sanitizeAgentName(name), podId });
              } else void submit();
            }}
            disabled={submitting || !namesReady || !pods.some((p) => p._id === podId)}
            className="v2-byo__submit"
          >
            {submitting ? t('agentByo.actions.issuing') : canReconnect
              ? t('agentConnection.reconnect') : t('agentByo.actions.install')}
          </button>}
          <button
            type="button"
            className="v2-byo__link"
            data-testid="byo-card-other-ways"
            onClick={() => setCompactByo(false)}
          >
            {t('agentByo.compact.otherWays')}
          </button>
        </div>
      )}
      {!showCompactHosted && !showCompactByo && !issued && !hosted && !placed && !reconnectRequest && (
        <div className="v2-byo__form">
          {(hosting?.configured || machines.length > 0) && (
            <>
            <p className="v2-byo__modes-question" id="byo-modes-question">{t('agentByo.mode.label')}</p>
            <div className="v2-byo__modes" role="group" aria-labelledby="byo-modes-question">
              <div className="v2-byo__mode-option">
                <button
                  type="button"
                  className="v2-byo__mode"
                  aria-pressed={mode === 'hosted'}
                  onClick={() => chooseMode('hosted')}
                  data-testid="byo-mode-hosted"
                >
                  <span className="v2-byo__mode-title">{t('agentByo.mode.hosted')}</span>
                </button>
                <V2Hint label={t('agentByo.mode.moreAbout', { mode: t('agentByo.mode.hosted') })}>
                  {t('agentByo.mode.hostedMeta', { turns: hosting.caps.turnsPerDay })}
                </V2Hint>
              </div>
              {machines.length > 0 && (
                <div className="v2-byo__mode-option">
                  <button
                    type="button"
                    className="v2-byo__mode"
                    aria-pressed={mode === 'machine'}
                    onClick={() => chooseMode('machine')}
                    data-testid="byo-mode-machine"
                  >
                    <span className="v2-byo__mode-title">{t('agentByo.mode.machine')}</span>
                  </button>
                  <V2Hint label={t('agentByo.mode.moreAbout', { mode: t('agentByo.mode.machine') })}>
                    {t('agentByo.mode.machineMeta')}
                  </V2Hint>
                </div>
              )}
              <div className="v2-byo__mode-option">
                <button
                  type="button"
                  className="v2-byo__mode"
                  aria-pressed={mode === 'byo'}
                  onClick={() => chooseMode('byo')}
                  data-testid="byo-mode-byo"
                >
                  <span className="v2-byo__mode-title">{t('agentByo.mode.byo')}</span>
                </button>
                <V2Hint label={t('agentByo.mode.moreAbout', { mode: t('agentByo.mode.byo') })}>
                  {t('agentByo.mode.byoMeta')}
                </V2Hint>
              </div>
            </div>
            </>
          )}
          {mode === 'machine' && (
            <label className={`v2-byo__field${errorField === 'machine' ? ' v2-byo__field--error' : ''}`}>
              <span className="v2-byo__label">{t('agentByo.form.machineLabel')}</span>
              <select
                value={machineId}
                onChange={(e) => { setErrorField(null); setMachineId(e.target.value); }}
                className="v2-byo__input"
                data-testid="byo-machine-select"
              >
                {machines.map((m) => (
                  <option key={m.machineId} value={m.machineId}>
                    {machineDisplayName(m, machines, t, i18n.language)} ({t(m.status === 'online' ? 'agentByo.machine.online' : 'agentByo.machine.offline')})
                  </option>
                ))}
              </select>
            </label>
          )}
          {mode === 'machine' && (
            <label className="v2-byo__field">
              <span className="v2-byo__label">{t('agentByo.form.adapterLabel')}</span>
              <select
                value={adapter}
                onChange={(e) => {
                  setAdapter(e.target.value as MachineAdapter);
                  setModel('');
                  setEffort('');
                }}
                className="v2-byo__input"
                data-testid="byo-adapter-select"
              >
                <option value="">{t('agentByo.form.adapterDefault')}</option>
                {/* What the computer reported decides the order and the note;
                    one it lacks stays selectable, since it may be installed next. */}
                {orderHarnessIds(harnessCatalog, machineInventory).map((id) => {
                  const note = harnessDeviceNote(machineInventory, id, t);
                  return <option key={id} value={id}>{harnessLabel(harnessCatalog, id)}{note ? ` · ${note}` : ''}</option>;
                })}
              </select>
            </label>
          )}
          {machineBlocked && (
            <p className="v2-byo__needs" data-testid="byo-machine-refused">
              {adapter === 'opencode'
                ? t('agentByo.opencode.machine', { byo: t('agentByo.mode.byo') })
                : refusedLine(adapter)}
            </p>
          )}
          {/* No OS field on a machine: hostUnconfined is reported from native
              Windows only, so it stands for 'windows'; anything else is unknown. */}
          {mode === 'machine' && connectorLine(adapter, selectedMachine?.hostUnconfined === true ? 'windows' : null)}
          {mode === 'machine' && (
            <V2HarnessChoice
              key={`machine:${adapter}`}
              catalog={harnessCatalog}
              harness={adapter}
              device={machineInventory.find((row) => row.harness === adapter) || null}
              model={model}
              effort={effort}
              onModel={setModel}
              onEffort={setEffort}
            />
          )}
          {runnerPicker}
          <label className={`v2-byo__field${errorField === 'name' || nameLookupError ? ' v2-byo__field--error' : ''}`}>
            <span className="v2-byo__label">{t('agentByo.form.nameLabel')}</span>
            <input
              type="text"
              value={name}
              onChange={(e) => { setErrorField(null); setNameTouched(true); setPendingReplacement(null); lastSuggestedName.current = null; setName(e.target.value); }}
              placeholder={DEFAULT_AGENT_NAME}
              className="v2-byo__input"
            />
            <span className="v2-byo__hint">
              {t('agentByo.form.nameHint')}
            </span>
          </label>
          <label className={`v2-byo__field${errorField === 'pod' ? ' v2-byo__field--error' : ''}`}>
            <span className="v2-byo__label">{t('agentByo.form.podLabel')}</span>
            <select
              value={podId}
              onChange={(e) => { setErrorField(null); setPendingReplacement(null); setPodId(e.target.value); }}
              className="v2-byo__input"
            >
              {pods.length === 0 && <option value="">{t('agentByo.form.loadingPods')}</option>}
              {pods.map((p) => (
                <option key={p._id} value={p._id}>
                  {p.name === 'My Workspace' && p.createdBy?._id && String(p.createdBy._id) !== String(currentUser?._id)
                    ? t('podNames.otherWorkspace', { name: p.name, owner: p.createdBy.username || t('podNames.shared') })
                    : p.name} ({p.type || DEFAULT_POD_TYPE})
                </option>
              ))}
            </select>
          </label>
          {/* The act sits right under the fields it acts on. Below "Add a computer" it
              fell under the fold at 1440x900 with "Run it here" chosen (QA 2026-10-16:
              its top edge at y=882), so a stranger saw a selected card and no button. */}
          {error && <div className="v2-byo__error">{error}</div>}
          {existingConnection && mode !== 'hosted' && (
            <div className="v2-byo__hint" data-testid="byo-connection-state">
              {connectionLabel(existingConnection.connection, t)}
            </div>
          )}
          {nameLookupError && mode === 'byo' && <div className="v2-byo__error">{t('agentByo.errors.nameLookupFailed')} <button type="button" className="v2-byo__link" onClick={() => setNameLookupRetry((n) => n + 1)}>{t('agentByo.actions.retry')}</button></div>}
          {mode === null ? (
            // Signal §3 not yet: a muted line where the act will be, until a
            // place to run it is chosen. Plain text, not a box, so it can't
            // read as a dead button (UX Lead, TASK-647 item 1).
            <div className="v2-byo__unchosen" data-testid="byo-mode-unchosen">
              {t('agentByo.actions.chooseFirst')}
            </div>
          ) : canReconnect ? (
              <button type="button" className="v2-byo__submit" disabled={submitting || !podId}
                onMouseDown={(event) => event.preventDefault()} onClick={() => {
                if (existingConnection.runtimeType === 'wrapper') void requestMachineReconnect(sanitizeAgentName(name));
                else void replaceRunningKey({ agentName: sanitizeAgentName(name), podId });
              }}>
                {t('agentConnection.reconnect')}
              </button>
            ) : isOtherOwner ? null : byoAlternative || (
            <button
              type="button"
              // Keep the focused field's hint visible through the press. If blur
              // hides it on mousedown, this button can move before mouseup.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => { void submit(); }}
              disabled={submitting || (mode === 'byo' && !namesReady) || !podId || machineBlocked}
              className="v2-byo__submit"
            >
              {(() => {
                if (mode === 'hosted') return submitting ? t('agentByo.actions.starting') : t('agentByo.actions.runHere');
                if (mode === 'machine') return submitting ? t('agentByo.actions.assigning') : t('agentByo.actions.assign');
                return submitting ? t('agentByo.actions.issuing') : t('agentByo.actions.install');
              })()}
            </button>
          )}
          {mode === 'byo' && (listenAdapter === 'claude' || listenAdapter === 'codex')
            && connectorLine(listenAdapter, setupOs)}
          {/* The run command is the quick try; it dies with its Terminal. The
              daemon is the one that keeps the agent running (TASK-645 item 3). */}
          {mode === 'byo' && machines.length === 0 && listenerAvailable && (
            <p className="v2-byo__hint" data-testid="byo-quick-try">{t(setupOs === 'windows' ? 'agentByo.quickTryWindows' : 'agentByo.quickTry')}</p>
          )}
          {/* One command is THE path (QA BYO walk 1): the daemon and the SDK
              are real alternatives, but shown as equals beside the button they
              read as a choice a stranger has to make before starting. */}
          <details className="v2-byo__more" data-testid="byo-more-ways"
            onMouseDownCapture={(event) => {
              if ((event.target as Element).closest('summary, button, a')) event.preventDefault();
            }}>
            <summary>{t('agentByo.otherWays.title')}</summary>
            {addComputerBlock}
          <p className="v2-byo__footnote">
            {t(listenerAvailable ? 'agentByo.footnote.cliRoute'
              // Only Codex on Linux has no listener among the page's two.
              : 'agentByo.footnote.cliRouteCodexUnavailable', {
              byo: t('agentByo.mode.byo'),
              hosted: t('agentByo.mode.hosted'),
              os: t(SETUP_OS_OPTIONS.find((o) => o.os === setupOs)?.labelKey || 'agentByo.listen.osMac'),
            })}{' '}
            {t('agentByo.footnote.notSure')}{' '}
            <a className="v2-byo__link" href="https://github.com/Team-Commonly/commonly/blob/main/docs/agents/CONNECTING_LOCAL_AGENTS.md" target="_blank" rel="noopener noreferrer">{t('agentByo.footnote.mcpVsCli')}</a>
            {' · '}
            <a className="v2-byo__link" href="https://github.com/Team-Commonly/commonly/blob/main/docs/MCP_INTEGRATION.md" target="_blank" rel="noopener noreferrer">{t('agentByo.footnote.fullWalkthrough')}</a>.
          </p>
          </details>
        </div>
      )}

      {pendingNarrowing && !issued && (
        <V2InstallNarrowingNotice
          agentName={pendingNarrowing.agentName}
          narrowing={pendingNarrowing.narrowing}
          busy={submitting}
          onConfirm={() => { void submit(true); }}
          onCancel={() => setPendingNarrowing(null)}
        />
      )}

      {pendingReplacement && !issued && (
        <div className="v2-byo__form" data-testid="byo-replace-key-confirmation">
          <p className="v2-byo__error">
            {t('agentByo.rekey.warning', { name: pendingReplacement.agentName })}
          </p>
          <button type="button" className="v2-byo__submit" disabled={submitting} onClick={() => { void replaceRunningKey(); }}>
            {submitting ? t('agentByo.actions.issuing') : t('agentByo.rekey.replace')}
          </button>
          <button type="button" className="v2-byo__link" onClick={() => setPendingReplacement(null)}>
            {t('agentByo.rekey.cancel')}
          </button>
        </div>
      )}

      {reconnectRequest && (
        <div className="v2-byo__result" data-testid="byo-reconnect-result">
          <h2>{reconnectRequest.agentName}</h2>
          <p>{t(`agentConnection.reconnect${reconnectRequest.state === 'connected' ? 'Done'
            : reconnectRequest.state === 'slow' ? 'Slow' : 'Waiting'}`)}</p>
        </div>
      )}

      {placed && (
        <div className="v2-byo__result" data-testid="byo-machine-result">
          <div className="v2-byo__result-hero">
            <V2Avatar name={placed.agentName} size="lg" kind={AGENT_KIND} seed={`${placed.agentName}:default`} online={placedState === 'running'} />
            <h2>{t('agentByo.machine.heading')} <code>{placed.agentName}</code></h2>
          </div>
          {placedState === 'running' ? (
            <p data-testid="byo-machine-running">{t('agentByo.machine.running', { machine: placed.machineName })}</p>
          ) : (
            <p data-testid={`byo-machine-${placedState}`}>
              {placedState === 'slow'
                ? t('agentByo.machine.slow', { machine: placed.machineName })
                : t('agentByo.machine.waiting', { machine: placed.machineName })}
            </p>
          )}
          <button
            type="button"
            className="v2-byo__submit"
            onClick={() => navigate(podId ? `/v2/pods/${podId}` : '/v2')}
          >
            {t('agentByo.machine.openPod')}
          </button>
        </div>
      )}

      {hosted && (
        <div className="v2-byo__result" data-testid="byo-hosted-result">
          <div className="v2-byo__result-hero">
            <V2Avatar name={hosted.agentName} size="lg" kind={AGENT_KIND} seed={`${hosted.agentName}:default`} online={hostedState === 'running'} />
            <h2>{t('agentByo.hosted.heading')} <code>{hosted.agentName}</code></h2>
          </div>
          <p>
            {t('agentByo.hosted.live', {
              name: hosted.agentName,
              pod: pods.find((p) => p._id === hosted.podId)?.name || '',
            })}
          </p>
          <p
            className={hostedState === 'running' ? 'v2-byo__live' : 'v2-byo__listen-note'}
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
          </div>
          <div className="v2-byo__cta-row">
            <button
              type="button"
              // Walk 4: typing the agent's 32-character handle cost 9.6s. The
              // pod opens with the composer already addressed to it.
              onClick={() => navigate(`/v2/pods/${hosted.podId}`, { state: { composeDraft: `@${hosted.agentName} ` } })}
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


          {/*
            Above the copy sits only what the paste needs: where, what it needs,
            the command (QA BYO walk 2: 112 words down to the box). What it
            does, the key-once line and the waiting state come after it.
            The listener comes FIRST, right under the heading: it is the step that
            makes the agent answer @mentions here. The MCP snippets below only let
            the user CALL Commonly from their editor. Users finished this flow, saw
            the agent in Your Team, mentioned it, and got silence; 4 of 6 mentions
            in 10 days went unanswered (#887), and the listener still sat below the
            editor snippets until 2026-10-14 (Growth's walk from Scout's card).
          */}
          <div className="v2-byo__snippet v2-byo__snippet--listen" data-testid="byo-listen">
            <div className="v2-byo__snippet-head">
              <span>{t(setupOs === 'windows' ? 'agentByo.listen.titleWindows' : 'agentByo.listen.title')}</span>
            </div>
            {/* Everything a stranger needs BEFORE the paste, in one place (QA
                BYO walk 1 found none of it on the page). One block, so other
                systems can add their own line beside it. */}
            <p className="v2-byo__os" data-testid="byo-setup-os" role="group" aria-label={t('agentByo.listen.osLabel')}>
              {SETUP_OS_OPTIONS.map(({ os, labelKey }) => (
                <button
                  key={os}
                  type="button"
                  className="v2-byo__link"
                  aria-pressed={setupOs === os}
                  data-testid={`byo-setup-os-${os}`}
                  onClick={() => setSetupOs(os)}
                >
                  {t(labelKey)}
                </button>
              ))}
            </p>
            {!listenerAvailable && (
              <p className="v2-byo__needs" data-testid="byo-listen-wont-answer">
                <strong>{t('agentByo.listen.wontAnswer', { name: issued.agentName })}</strong>
                {hosting?.configured && (
                  <>
                    {' '}
                    <button
                      type="button"
                      className="v2-byo__secondary"
                      data-testid="byo-listen-run-here"
                      disabled={submitting}
                      onClick={startHostedInstead}
                    >
                      {t('agentByo.mode.hosted')}
                    </button>
                  </>
                )}
                {error && <span className="v2-byo__error" role="alert"> {error}</span>}
              </p>
            )}
            <p className="v2-byo__needs" data-testid={listenerAvailable ? 'byo-listen-needs' : 'byo-listen-unavailable'}>
              {listenerAvailable
                ? `${t(setupOs === 'windows' ? 'agentByo.listen.needsWindows' : 'agentByo.listen.needs', {
                  tool: listenAdapter === 'codex' ? t('agentByo.listen.toolCodex')
                : listenAdapter === 'claude' ? t('agentByo.listen.toolClaude') : listenTool,
                })}${setupOs === 'linux' ? ` ${t('agentByo.listen.needsLinuxBwrap')}` : ''}`
                : t(listenAdapter === 'codex' && setupOs === 'windows' ? 'agentByo.listen.unavailableCodexWindows'
                    : listenAdapter === 'codex' ? 'agentByo.listen.unavailableCodex'
                    : listenAdapter === 'dsh' ? 'agentByo.listen.unavailableDsh' : 'agentByo.listen.unavailableOther', {
                  os: t(SETUP_OS_OPTIONS.find((o) => o.os === setupOs)?.labelKey || 'agentByo.listen.osMac'),
                  tool: listenTool,
                })}{' '}
              <button
                type="button"
                className="v2-byo__link"
                data-testid="byo-use-different-runner"
                onClick={backToStart}
              >
                {t('agentByo.listen.useDifferentRunner')}
              </button>
            </p>
            {/* Directly above the lines it explains: both last lines carry --unsandboxed. */}
            {listenerAvailable && setupOs === 'windows' && (
              <p className="v2-byo__listen-note" data-testid="byo-listen-windows">
                <Trans
                  i18nKey={listenAdapter === 'codex' ? 'agentByo.listen.windowsCodex' : 'agentByo.listen.windowsNote'}
                  values={{ name: issued.agentName }}
                  components={{ cmd: <code /> }}
                />
              </p>
            )}
            {listenerAvailable && (
              <div className="v2-byo__command" onCopy={() => { copiedIssuedContent(); markCopiedKind('listen'); }}>
                <pre className="v2-byo__pre">{listenSnippet}</pre>
                <button
                  type="button"
                  onClick={() => copy('listen', listenSnippet)}
                  className="v2-byo__copy"
                >
                  {copied === 'listen' ? t('agentByo.actions.copied') : t('agentByo.actions.copy')}
                </button>
              </div>
            )}
            {listenerAvailable && (
              <p className="v2-byo__listen-note" data-testid="byo-listen-npm-hint">
                {t(setupOs === 'windows' ? 'agentByo.listen.scriptsDisabled' : 'agentByo.listen.npmPermission')}
              </p>
            )}
            {listenerAvailable && (
              <p className="v2-byo__listen-note" data-testid="byo-listen-stops-on-close">
                {t(setupOs === 'windows'
                  ? (machines.length === 0 ? 'agentByo.listen.stopsOnCloseWindows' : 'agentByo.listen.stopsOnCloseWithComputerWindows')
                  : (machines.length === 0 ? 'agentByo.listen.stopsOnClose' : 'agentByo.listen.stopsOnCloseWithComputer'))}
              </p>
            )}
            {!listenerAvailable ? null : listenState === 'listening' ? (
              <p className="v2-byo__live" data-testid="byo-listen-ok">
                {t('agentByo.listen.verified', { name: issued.agentName })}
              </p>
            ) : (
              <p className="v2-byo__listen-note" data-testid="byo-listen-waiting">
                {missedWindowOver && copiedKinds.mcp && !copiedKinds.listen
                  ? t('agentByo.listen.missedCommand', { name: issued.agentName })
                  : listenState === 'timeout'
                    ? t('agentByo.listen.stillWaiting', { name: issued.agentName })
                    : t('agentByo.listen.waiting', { name: issued.agentName })}
              </p>
            )}
            {listenerAvailable && (
              <>
                <p className="v2-byo__listen-note">
                  {t(setupOs === 'windows' ? 'agentByo.listen.noteWindows' : 'agentByo.listen.note', { name: issued.agentName })}
                </p>
              </>
            )}
            {/* Both reach notes describe a confinement Windows doesn't have; the
                Windows note above says what holds there instead. */}
            {listenerAvailable && listenAdapter === 'claude' && setupOs !== 'windows' && (
              <p className="v2-byo__listen-note" data-testid="byo-listen-reach">
                {t(setupOs === 'linux' ? 'agentByo.listen.reachClaudeLinux' : 'agentByo.listen.reachClaude', { name: issued.agentName })}
              </p>
            )}
            {listenerAvailable && repoChoiceAvailable && (
              <div className="v2-byo__listen-note" data-testid="byo-repo-choice">
                <label>
                  <input
                    type="checkbox"
                    data-testid="byo-repo-toggle"
                    checked={workInRepo}
                    onChange={(e) => setWorkInRepo(e.target.checked)}
                  />
                  {' '}{t('agentByo.listen.repo.label')}
                </label>
                <p>{t('agentByo.listen.repo.hint')}</p>
                {workInRepo && (
                  <>
                    <label>
                      <input
                        type="checkbox"
                        data-testid="byo-repo-write"
                        checked={allowWrite}
                        onChange={(e) => setAllowWrite(e.target.checked)}
                      />
                      {' '}{t('agentByo.listen.repo.write')}
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        data-testid="byo-repo-web"
                        checked={allowWeb}
                        onChange={(e) => setAllowWeb(e.target.checked)}
                      />
                      {' '}{t('agentByo.listen.repo.web')}
                    </label>
                    <p data-testid="byo-repo-folder-note">{t('agentByo.listen.repo.folder')}</p>
                    <p data-testid="byo-repo-saved-note">{t('agentByo.listen.repo.saved')}</p>
                  </>
                )}
              </div>
            )}
            {listenerAvailable && listenAdapter === 'codex' && setupOs !== 'windows' && (
              <p className="v2-byo__listen-note" data-testid="byo-listen-reach-codex">
                {t('agentByo.listen.reachCodex')}
              </p>
            )}
          </div>
          <p data-testid="byo-key-once">{t('agentByo.result.keyOnce')}</p>

          {listenAdapter === 'claude' && (() => {
            const mcpBlock = (
  <div className="v2-byo__snippet" data-testid="byo-mcp-claude">
                <div className="v2-byo__snippet-head">
                  <span>{t('agentByo.snippets.claudeCode')}</span>
                </div>
                <p className="v2-byo__hint">
                  {t(
                    setupOs === 'windows' ? 'agentByo.snippets.claudeCodeBodyWindows' : 'agentByo.snippets.claudeCodeBody',
                    { name: issued.agentName },
                  )}
                </p>
                <div className="v2-byo__command" onCopy={() => { copiedIssuedContent(); markCopiedKind('mcp'); }}>
                  <pre className="v2-byo__pre">{setupOs === 'windows' ? claudeSnippetWindows : claudeSnippet}</pre>
                  <button
                    type="button"
                    onClick={() => copy('claude', setupOs === 'windows' ? claudeSnippetWindows : claudeSnippet)}
                    className="v2-byo__copy"
                  >
                    {copied === 'claude' ? t('agentByo.actions.copied') : t('agentByo.actions.copy')}
                  </button>
                </div>
              </div>
            );
            // Claude Code always has a listener now (F96), so the MCP command is
            // the extra: folded away and labelled, because a stranger copied it
            // three times, never ran the listener, and the agent never answered
            // (walk 2026-10-31).
            return (
              <details className="v2-byo__more" data-testid="byo-mcp-details">
                <summary>{t('agentByo.snippets.mcpSummary')}</summary>
                {mcpBlock}
              </details>
            );
          })()}

          <details className="v2-byo__more" data-testid="byo-result-more-ways">
            <summary>{t('agentByo.otherWays.title')}</summary>
            {addComputerBlock}
            {machines.length > 0 && (
              // A computer on file: the machine choice is the start form's mode
              // picker, which this result page does not show, so offer it here.
              <button
                type="button"
                className="v2-byo__secondary"
                data-testid="byo-result-on-my-computer"
                onClick={() => { setIssued(null); chooseMode('machine'); }}
              >
                {t('agentByo.mode.machine')}
              </button>
            )}
            <div className="v2-byo__snippet">
              <div className="v2-byo__snippet-head">
                <span>{t('agentByo.snippets.runtimeToken')}</span>
              </div>
              <div className="v2-byo__command" onCopy={copiedIssuedContent}>
                <pre className="v2-byo__pre">{issued.token}</pre>
                <button type="button" onClick={() => copy('tok', issued.token)} className="v2-byo__copy">
                  {copied === 'tok' ? t('agentByo.actions.copied') : t('agentByo.actions.copy')}
                </button>
              </div>
            </div>
            <div className="v2-byo__snippet">
              <div className="v2-byo__snippet-head">
                <span>{t('agentByo.snippets.cursor')}</span>
              </div>
              <a className="v2-byo__cursor-link" href={cursorInstallHref}>{t('agentByo.snippets.cursorInstall')}</a>
              <p className="v2-byo__hint">{t('agentByo.snippets.cursorInstallHint')}</p>
              <div className="v2-byo__command" onCopy={() => { copiedIssuedContent(); markCopiedKind('mcp'); }}>
                <pre className="v2-byo__pre">{cursorSnippet}</pre>
                <button type="button" onClick={() => copy('cursor', cursorSnippet)} className="v2-byo__copy">
                  {copied === 'cursor' ? t('agentByo.actions.copied') : t('agentByo.actions.copy')}
                </button>
              </div>
            </div>
          </details>



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
            {listenState !== 'listening' && listenerAvailable && (
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
            kind={AGENT_KIND}
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
      </aside>
      </div>
          {issued && listenerAvailable && showHostedOffer && !hasCopied && hosting?.configured && listenState !== 'listening' && (
            <section role="status" className="v2-byo__hosted-offer" aria-label={t('agentByo.hosted.offerAction')}>
              <p>{t('agentByo.hosted.offerBody')}</p>
              <button type="button" className="v2-byo__submit v2-byo__hosted-offer-action" disabled={submitting} onClick={startHostedInstead}>
                {submitting ? t('agentByo.hosted.starting', { name: t('agentByo.preview.title') }) : t('agentByo.hosted.offerAction')}
              </button>
              {error && <p className="v2-byo__error" role="alert">{error}</p>}
            </section>
          )}
    </V2FeaturePage>
  );
};

export default V2AgentBYO;
