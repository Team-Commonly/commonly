import React, {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import V2Avatar from './V2Avatar';
import V2MessageBubble from './V2MessageBubble';
import {
  UseV2PodDetailResult,
  V2Agent,
} from '../hooks/useV2PodDetail';
import { useV2Api } from '../hooks/useV2Api';
import { UseV2PodsResult, V2PodMember } from '../hooks/useV2Pods';
import { useSocket } from '../../context/SocketContext';
import { useAuth } from '../../context/AuthContext';
import { initialsFor } from '../utils/avatars';
import { isGroupedWithPrevious } from '../utils/messageGrouping';
import { Trans, useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { V2InviteTab } from './V2InviteModal';

import V2ThreadCard from './V2ThreadCard';
import { useV2ThreadState } from '../hooks/useV2ThreadState';
import { buildThreadView } from '../utils/threadView';

const PLAN_MODE_KEY = 'v2.podMode';
const AGENT_DELIVERY_HINT_KEY = 'v2.agentDeliveryHint';
const JUST_CREATED_POD_KEY = 'v2.justCreated';

const STARTER_PROMPT_KEYS = [
  'podChat.starters.introduce',
  'podChat.starters.help',
  'podChat.starters.firstQuestion',
] as const;
const CLOSE_MARK = '×';
const COMMAND_KEY = '⌘';
const ENTER_KEY = '↵';

type PodMode = 'plan' | 'execute';

const podMarkFor = (name: string, type: string | undefined, dmLabel: string): string => (
  type === 'agent-room' ? dmLabel : initialsFor(name).slice(0, 2)
);

const normalizeAgentSegment = (value: string | undefined): string =>
  (value || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);

// Per-user agents carry OPAQUE instance tokens (the u+sha10 convention, plus
// the legacy long form) — machine keys, never identities. A moltbot's
// instanceId ("aria") is the opposite: the human-chosen name, with agentName
// as the runtime label we must never surface. So handle preference is:
// human-meaningful instanceId wins; opaque token falls back to the
// displayName slug (the backend mention map indexes displaySlug for every
// installation), then agentName. That's how Scout gets @scout while
// agentName stays 'guide' — and both handles land.
const isOpaqueInstanceToken = (value: string | undefined): boolean =>
  /^u[a-f0-9]{10}([a-f0-9]{14})?$/.test((value || '').toLowerCase());

// Mirrors the backend mention map's slugify (agentMentionService) — keep the
// two identical or a typed handle can render but not resolve.
const slugifyHandle = (value: string | undefined): string => (value || '')
  .toString()
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9-]/g, '-')
  .replace(/-+/g, '-')
  .replace(/^-+|-+$/g, '');

// Mirrors backend AgentIdentityService.buildAgentUsername — instance suffix
// elides when default/empty/equal to base name. Used to wire a mention back
// to the agent's User row username.
const buildAgentUsername = (agentName: string | undefined, instanceId: string | undefined): string => {
  const base = normalizeAgentSegment(agentName);
  const inst = normalizeAgentSegment(instanceId);
  if (!inst || inst === 'default' || inst === base) return base || 'agent';
  return `${base}-${inst}`;
};

// Find an "active" @-mention context in the textarea: the closest @ to the
// left of the cursor that's at start-of-string or preceded by whitespace/
// quotation, with no whitespace between it and the cursor. Mirrors v1
// ChatRoom.getMentionContext so behavior matches.
const getMentionContext = (text: string, cursor: number | null): { start: number; query: string } | null => {
  if (!text || cursor == null) return null;
  const atIndex = text.lastIndexOf('@', cursor - 1);
  if (atIndex < 0) return null;
  const beforeChar = text[atIndex - 1];
  if (beforeChar && !/\s|[([{"'`]/.test(beforeChar)) return null;
  const between = text.slice(atIndex + 1, cursor);
  if (/\s/.test(between)) return null;
  return { start: atIndex, query: between };
};

interface MentionItem {
  id: string;
  label: string;
  labelLower: string;
  subtitle: string;
  avatar?: string | null;
  isAgent: boolean;
  // Value inserted after `@`. For agents, prefer instanceId so mentions land
  // on the right instance ("@nova" not "@openclaw").
  value: string;
  // #891 surface 1: reachability shown at compose time, so nobody offers a
  // mention that can't land without saying so.
  reach?: AgentReachState;
}

// #891 surface 1 — per-agent reachability from /api/pods/:podId/agent-states.
// Only the states the kernel can derive HONESTLY for the agent's runtime
// class arrive here; 'reachable'/'unknown' render nothing.
type AgentReachState = 'listening' | 'gone-dark' | 'never-connected' | 'reachable' | 'unknown';
interface AgentStateRow {
  agentName: string;
  instanceId: string;
  state: AgentReachState;
  isOwner: boolean;
  fixCommand?: string;
}
const REACH_NEEDS_WARNING = new Set<AgentReachState>(['gone-dark', 'never-connected']);

interface TypingAgentEntry {
  key: string;
  agentName: string;
  instanceId?: string;
  displayName: string;
  avatar?: string;
}

const TypingIndicator: React.FC<{ agents: TypingAgentEntry[] }> = ({ agents }) => {
  const { t, i18n } = useTranslation();
  if (!agents || agents.length === 0) return null;
  const names = agents.map((a) => a.displayName);
  const label = names.length === 1
    ? t('podChat.typing.one', { name: names[0] })
    : names.length === 2
      ? t('podChat.typing.two', { first: names[0], second: names[1] })
      : t('podChat.typing.many', {
        first: names[0],
        second: names[1],
        count: names.length - 2,
        formattedCount: new Intl.NumberFormat(i18n.resolvedLanguage || i18n.language || 'en')
          .format(names.length - 2),
      });
  return (
    <div className="v2-chat__typing" aria-live="polite">
      <div className="v2-chat__typing-avatars">
        {agents.slice(0, 3).map((a) => (
          <V2Avatar key={a.key} name={a.displayName || a.agentName} src={a.avatar} size="sm" />
        ))}
      </div>
      <span className="v2-chat__typing-label">{label}</span>
      <span className="v2-chat__typing-dots" aria-hidden="true">
        <span /><span /><span />
      </span>
    </div>
  );
};

const modeCopy = (mode: PodMode, t: TFunction) => (
  mode === 'plan'
    ? t('podChat.mode.planDescription')
    : t('podChat.mode.executeDescription')
);

const readMode = (podId: string): PodMode => {
  try {
    const raw = localStorage.getItem(`${PLAN_MODE_KEY}.${podId}`);
    return raw === 'execute' ? 'execute' : 'plan';
  } catch {
    return 'plan';
  }
};

const writeMode = (podId: string, mode: PodMode) => {
  try {
    localStorage.setItem(`${PLAN_MODE_KEY}.${podId}`, mode);
  } catch {
    // localStorage unavailable; revert to default on next render.
  }
};

interface V2PodChatProps {
  detail: UseV2PodDetailResult;
  podsState?: UseV2PodsResult;
  // V2Layout owns the shell-level first-run modal. This flag reserves the
  // empty-state slot while its status probe resolves and keeps the just-created
  // starter panel behind the modal when onboarding is active.
  firstRunVisible?: boolean;
  // Inspector wiring — when present, the avatar group becomes the "show team"
  // entry. Inspector itself is rendered by V2Layout so this is just the
  // hand-off point.
  inspectorCollapsed?: boolean;
  onToggleInspector?: () => void;
  onOpenMember?: (agentKey: string) => void;
  // Opens the shared invite modal (rendered by V2Layout). The header
  // invite icon delegates to this so the chat path matches the inspector
  // path and a single modal instance handles both surfaces.
  onOpenInvite?: (initialTab?: V2InviteTab) => void;
  // Click on an in-message file pill routes here. Passed straight through
  // to V2MessageBubble → FilePill so the click opens the inspector
  // artifact preview instead of window.open()'ing a raw file in a new tab.
  onOpenFile?: (fileName: string) => void;
  // Opens the mobile pods drawer (<=760px). The hamburger in the chat header
  // is the primary way back to the pod list on phones, where the sidebar is
  // an overlay rather than a visible column. Hidden via CSS on desktop.
  onOpenMobileNav?: () => void;
}

const Icon = ({ d }: { d: string }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

const V2PodChat: React.FC<V2PodChatProps> = ({ detail, firstRunVisible = false, inspectorCollapsed, onToggleInspector, onOpenMember, onOpenInvite, onOpenFile, onOpenMobileNav }) => {
  const { t, i18n } = useTranslation();
  const numberFormatter = new Intl.NumberFormat(i18n.resolvedLanguage || i18n.language || 'en');
  const {
    pod, members, messages, agents, sendMessage, loading, error, sendError,
    hasMore, loadingOlder, loadOlder,
  } = detail;
  const api = useV2Api();
  const { socket, connected } = useSocket();
  const { currentUser } = useAuth();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [justCreatedPodId, setJustCreatedPodId] = useState<string | null>(null);
  const [starterInviteUrl, setStarterInviteUrl] = useState('');
  const [starterInviteLoading, setStarterInviteLoading] = useState(false);
  const [starterInviteError, setStarterInviteError] = useState<string | null>(null);
  const [starterInviteCopied, setStarterInviteCopied] = useState(false);
  const [agentDeliveryHint, setAgentDeliveryHint] = useState<{
    messageId: string;
    mentionHandle: string;
  } | null>(null);
  const deliveryHintShownPodsRef = useRef<Set<string>>(new Set());
  const [mode, setMode] = useState<PodMode>(pod ? readMode(pod._id) : 'plan');
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const mentionDropdownRef = useRef<HTMLDivElement | null>(null);
  const starterInviteRequestedPodRef = useRef<string | null>(null);
  const starterInviteActivePodRef = useRef<string | null>(null);

  // Agent typing indicator state. Backend already emits agent_typing_start/
  // agent_typing_stop via agentTypingService — this just listens and renders.
  // Keyed by `${agentName}:${instanceId || ''}` to handle multi-instance.
  const [typingAgents, setTypingAgents] = useState<TypingAgentEntry[]>([]);
  const typingAgentTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // Reply threading: the message the next send responds to (backend
  // replyToMessageId — agents already thread replies; this is the human side).
  // MUST live above the `if (!pod)` early return with the other hooks —
  // placing it after broke the hook order (React #310) and crashed the pod
  // page on first load (caught in post-deploy browser verification).
  const [replyTarget, setReplyTarget] = useState<import('../hooks/useV2PodDetail').V2Message | null>(null);

  // The thread the composer is aimed at (constraint 4). ONE composer, two chip
  // states, never both: setting either target clears the other. Kept beside
  // replyTarget and above the `if (!pod)` return for the same hook-order
  // reason recorded above — this file has crashed on that once already.
  const [threadTarget, setThreadTarget] = useState<{ id: string; preview: string } | null>(null);

  // Per-user thread state for this pod (#1145). `collapsed` arrives resolved;
  // this component must never compute it.
  const threadState = useV2ThreadState(detail?.pod?._id);

  // Setting one composer target clears the other. Two chips would be two
  // meanings for one send, and the resolver rejects a message carrying both.
  const aimAtThread = useCallback((rootId: string, preview: string) => {
    setReplyTarget(null);
    setThreadTarget({ id: rootId, preview });
  }, []);
  const aimAtMessage = useCallback((m: import('../hooks/useV2PodDetail').V2Message) => {
    setThreadTarget(null);
    setReplyTarget(m);
  }, []);

  // @-mention dropdown state. mentionStart is the index of the `@` in the
  // textarea so we know the slice to replace on select.
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionStart, setMentionStart] = useState(-1);
  const [mentionIndex, setMentionIndex] = useState(0);

  // #891 surface 1: agent reachability at the moment of composing a mention.
  // Best-effort — a failed read renders nothing rather than something wrong,
  // and 60s refresh keeps the states honest without hammering the endpoint.
  const [agentStates, setAgentStates] = useState<AgentStateRow[]>([]);
  useEffect(() => {
    const podId = pod?._id;
    if (!podId) return undefined;
    let cancelled = false;
    const load = async () => {
      try {
        const data = await api.get<{ agents?: AgentStateRow[] }>(`/api/pods/${podId}/agent-states`);
        if (!cancelled) setAgentStates(data?.agents || []);
      } catch {
        // Honesty surface is best-effort: silence over a wrong dot.
      }
    };
    load();
    const timer = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [pod?._id, api]);

  // Lookup by every handle a mention could use: instanceId (what the
  // dropdown inserts for non-default instances) and agentName.
  const agentStateByHandle = useMemo(() => {
    const map = new Map<string, AgentStateRow>();
    agentStates.forEach((s) => {
      // Defensive on shape: this surface promises "silence over a wrong
      // dot", and that must include a malformed payload. A backend
      // regression that returned bare strings here crashed the ENTIRE pod
      // page via this exact line (2026-08-13 agentStateService clobber) —
      // degrade to no-dots, never to an error boundary.
      const agentName = typeof s?.agentName === 'string' ? s.agentName : '';
      if (!agentName) return;
      map.set(agentName.toLowerCase(), s);
      if (typeof s.instanceId === 'string' && s.instanceId && s.instanceId !== 'default') {
        map.set(s.instanceId.toLowerCase(), s);
      }
    });
    return map;
  }, [agentStates]);

  useEffect(() => {
    if (pod) setMode(readMode(pod._id));
  }, [pod?._id]);

  useEffect(() => {
    setAgentDeliveryHint(null);
  }, [pod?._id]);

  useEffect(() => {
    const podId = pod?._id || null;
    starterInviteActivePodRef.current = podId;
    starterInviteRequestedPodRef.current = null;
    setStarterInviteUrl('');
    setStarterInviteError(null);
    setStarterInviteLoading(false);
    setStarterInviteCopied(false);
    if (!podId) {
      setJustCreatedPodId(null);
      return;
    }
    try {
      setJustCreatedPodId(
        sessionStorage.getItem(`${JUST_CREATED_POD_KEY}.${podId}`) === '1' ? podId : null,
      );
    } catch {
      setJustCreatedPodId(null);
    }
  }, [pod?._id]);

  const clearJustCreatedPod = useCallback((podId: string) => {
    try {
      sessionStorage.removeItem(`${JUST_CREATED_POD_KEY}.${podId}`);
    } catch {
      // State still clears for this mount when sessionStorage is unavailable.
    }
    setJustCreatedPodId((current) => (current === podId ? null : current));
  }, []);

  useEffect(() => {
    if (!pod?._id || messages.length === 0 || justCreatedPodId !== pod._id) return;
    clearJustCreatedPod(pod._id);
  }, [clearJustCreatedPod, justCreatedPodId, messages.length, pod?._id]);

  const generateStarterInvite = useCallback(async (podId: string) => {
    starterInviteRequestedPodRef.current = podId;
    setStarterInviteLoading(true);
    setStarterInviteError(null);
    setStarterInviteCopied(false);
    try {
      const data = await api.post<{ token?: string }>(`/api/pods/${podId}/invites`, {});
      if (!data?.token) throw new Error('missing invite token');
      if (starterInviteActivePodRef.current !== podId) return;
      setStarterInviteUrl(`${window.location.origin}/v2/invite/${data.token}`);
    } catch {
      if (starterInviteActivePodRef.current !== podId) return;
      starterInviteRequestedPodRef.current = null;
      setStarterInviteError(t('podChat.newPod.inviteError'));
    } finally {
      if (starterInviteActivePodRef.current === podId) setStarterInviteLoading(false);
    }
  }, [api, t]);

  const starterPanelVisible = Boolean(
    pod
    && justCreatedPodId === pod._id
    && messages.length === 0
    && !loading
    && !firstRunVisible,
  );

  useEffect(() => {
    if (!starterPanelVisible || !pod?._id || starterInviteUrl) return;
    if (starterInviteRequestedPodRef.current === pod._id) return;
    void generateStarterInvite(pod._id);
  }, [generateStarterInvite, pod?._id, starterInviteUrl, starterPanelVisible]);

  const handleStarterInviteCopy = useCallback(async () => {
    if (!starterInviteUrl) return;
    try {
      await navigator.clipboard.writeText(starterInviteUrl);
      setStarterInviteCopied(true);
    } catch {
      // The read-only field remains selectable for manual copy.
    }
  }, [starterInviteUrl]);

  // Auto-scroll belongs to NEW messages only. Keyed on `messages.length` this
  // also fired when a page of history was prepended, yanking the reader from
  // the older message they had just asked for straight back to the bottom —
  // which reads as "load older is broken". Key on the newest message's id so
  // prepends are ignored.
  const newestMessageId = messages.length > 0 ? messages[messages.length - 1].id : null;
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [newestMessageId]);

  // Prepending changes scrollHeight, so without this the viewport jumps. Hold
  // the reader's position by restoring the distance from the BOTTOM, which is
  // invariant under a prepend.
  const scrollAnchorRef = useRef<number | null>(null);
  const handleLoadOlder = useCallback(async () => {
    const el = messagesContainerRef.current;
    scrollAnchorRef.current = el ? el.scrollHeight - el.scrollTop : null;
    await loadOlder();
  }, [loadOlder]);

  useLayoutEffect(() => {
    const el = messagesContainerRef.current;
    const anchor = scrollAnchorRef.current;
    if (!el || anchor == null) return;
    el.scrollTop = el.scrollHeight - anchor;
    scrollAnchorRef.current = null;
  }, [messages]);

  // Removed: Lead-pill computation. The "Lead" label was just `idx === 0`,
  // which made whichever agent installed first (usually auto-installed
  // commonly-bot) appear as Lead — pure positional, no actual semantic.
  // If we re-introduce a lead concept, it needs real data on the
  // AgentInstallation row, not a frontend heuristic.

  // Map of agent-user username → per-installation displayName. Mirrors
  // backend AgentIdentityService.buildAgentUsername: '<agentName>' when
  // instanceId is 'default' or matches the agentName, else
  // '<agentName>-<instanceId>'. Lets V2MessageBubble render "Engineer (Nova)"
  // instead of the raw User row username "openclaw-nova".
  //
  // Note: the backend payload key is `name` (per buildAgentInstallationPayload
  // in registry helpers), but V2Agent's TypeScript shape declares `agentName`
  // — the type doesn't match the wire. Read both to survive either source.
  const agentDisplayNames = React.useMemo(() => {
    const map = new Map<string, string>();
    if (!agents) return map;
    for (const agent of agents) {
      const rawName = (agent as { name?: string; agentName?: string }).name
        || agent.agentName || '';
      const name = rawName.toLowerCase();
      const instance = (agent.instanceId || '').toLowerCase();
      const username = !instance || instance === 'default' || instance === name
        ? name
        : `${name}-${instance}`;
      const display = agent.displayName || agent.profile?.displayName || rawName;
      if (username && display) map.set(username, display);
    }
    return map;
  }, [agents]);

  // username/displayName → agent key (instanceId or agentName) so a click on
  // a chat author byline can drive the inspector to the right member sub-page.
  // Backend `message.user.username` may carry either the raw User row username
  // ("openclaw-aria") or the substituted displayName ("Strategist (Aria)") —
  // index by both so resolution survives either shape.
  const agentKeyByAuthorString = React.useMemo(() => {
    const map = new Map<string, string>();
    if (!agents) return map;
    for (const agent of agents) {
      const rawName = (agent as { name?: string; agentName?: string }).name
        || agent.agentName || '';
      const name = rawName.toLowerCase();
      const instance = (agent.instanceId || '').toLowerCase();
      const username = !instance || instance === 'default' || instance === name
        ? name
        : `${name}-${instance}`;
      const key = agent.instanceId || agent.agentName;
      if (!key) continue;
      if (username) map.set(username, key);
      const display = agent.displayName || agent.profile?.displayName;
      if (display) map.set(display.toLowerCase(), key);
    }
    return map;
  }, [agents]);

  const handleAuthorClick = useCallback((author: string) => {
    if (!onOpenMember) return;
    const key = agentKeyByAuthorString.get(author.toLowerCase());
    if (key) onOpenMember(key);
  }, [agentKeyByAuthorString, onOpenMember]);

  const agentAuthorKeys = React.useMemo(
    () => new Set(agentKeyByAuthorString.keys()),
    [agentKeyByAuthorString],
  );

  // Build the @-mention list. members[] is User rows (humans + agent users);
  // agents[] is AgentInstallation rows that carry the instanceId. We want
  // @nova in the dropdown, not @openclaw-nova — so for any member that has
  // a matching installation, promote it to the agent shape (instance handle,
  // role subtitle). Agents that aren't (yet) members are appended at the end.
  const mentionableItems: MentionItem[] = useMemo(() => {
    const items: MentionItem[] = [];
    const seen = new Set<string>();

    const agentByUsername = new Map<string, V2Agent>();
    (agents || []).forEach((a) => {
      const rawName = (a as { name?: string; agentName?: string }).name || a.agentName || '';
      if (!rawName) return;
      agentByUsername.set(buildAgentUsername(rawName, a.instanceId), a);
    });

    const itemFromAgent = (a: V2Agent, fallbackAvatar: string | null = null): MentionItem | null => {
      const rawName = (a as { name?: string; agentName?: string }).name || a.agentName || '';
      if (!rawName) return null;
      const username = buildAgentUsername(rawName, a.instanceId);
      const display = a.displayName || a.profile?.displayName || rawName;
      const instance = (a.instanceId || 'default').toLowerCase();
      // Handle preference: a human-chosen instanceId ("aria") IS the
      // identity and stays the handle — agentName there is the runtime label
      // we never surface. An OPAQUE per-user token (guide/u3f9c2a1b7d) is a
      // machine key and must never be the handle; fall back to the persona's
      // displayName slug (@scout — the mention map indexes displaySlug),
      // then the bare agentName (single-install rule).
      const mentionValue = instance && instance !== 'default' && instance !== rawName.toLowerCase()
        && !isOpaqueInstanceToken(instance)
        ? instance
        : (slugifyHandle(display) || rawName.toLowerCase());
      const avatar = a.profile?.avatarUrl || a.profile?.iconUrl || a.iconUrl || fallbackAvatar;
      // Compose-time honesty (#891 surface 1): a mention that can't land says
      // so in the picker itself — certainty-matched copy (never-connected is
      // structural and flat; gone-dark is inferred and hedged).
      const reach = agentStateByHandle.get(mentionValue)?.state
        || agentStateByHandle.get(rawName.toLowerCase())?.state;
      const subtitle = reach === 'never-connected'
        ? t('podChat.mentionState.typeaheadNever', { handle: mentionValue })
        : reach === 'gone-dark'
          ? t('podChat.mentionState.typeaheadDark', { handle: mentionValue })
          : t('podChat.mentions.agentSubtitle', { handle: mentionValue });
      return {
        id: username,
        label: display,
        labelLower: `${display} ${rawName} ${username} ${mentionValue}`.toLowerCase(),
        subtitle,
        avatar,
        isAgent: true,
        value: mentionValue,
        reach,
      };
    };

    (members || []).forEach((m: V2PodMember) => {
      const username = m.username || '';
      if (!username) return;
      const key = username.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      const agentMatch = agentByUsername.get(key);
      if (agentMatch) {
        const item = itemFromAgent(agentMatch, m.profilePicture || null);
        if (item) items.push(item);
        return;
      }
      items.push({
        id: m._id || username,
        label: username,
        labelLower: username.toLowerCase(),
        subtitle: t('podChat.mentions.member'),
        avatar: m.profilePicture || null,
        isAgent: false,
        value: username,
      });
    });

    (agents || []).forEach((a: V2Agent) => {
      const rawName = (a as { name?: string; agentName?: string }).name || a.agentName || '';
      if (!rawName) return;
      const username = buildAgentUsername(rawName, a.instanceId);
      const key = username.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      const item = itemFromAgent(a);
      if (item) items.push(item);
    });

    return items;
  }, [members, agents, t, agentStateByHandle]);

  // #891 surface 1, send-time half: which mentioned agents in the current
  // draft cannot hear it? Dependency-keyed explanation for everyone; the fix
  // command only ever arrives for owners (the endpoint enforces the split).
  const unreachableMentioned = useMemo(() => {
    if (!draft.includes('@')) return [] as AgentStateRow[];
    const tokens: string[] = draft.match(/@([a-z0-9][\w-]*)/gi) || [];
    const seen = new Set<string>();
    const rows: AgentStateRow[] = [];
    tokens.forEach((token) => {
      const handle = token.slice(1).toLowerCase();
      const state = agentStateByHandle.get(handle);
      if (!state || !REACH_NEEDS_WARNING.has(state.state) || seen.has(handle)) return;
      seen.add(handle);
      rows.push({ ...state, agentName: handle });
    });
    return rows;
  }, [draft, agentStateByHandle]);

  const filteredMentions: MentionItem[] = useMemo(() => {
    if (!mentionOpen) return [];
    const q = mentionQuery.trim().toLowerCase();
    return mentionableItems.filter((item) => item.labelLower.includes(q)).slice(0, 8);
  }, [mentionOpen, mentionQuery, mentionableItems]);

  const updateMentionState = useCallback((nextValue: string, cursorPosition: number | null) => {
    const ctx = getMentionContext(nextValue, cursorPosition);
    if (!ctx) {
      setMentionOpen(false);
      setMentionQuery('');
      setMentionStart(-1);
      return;
    }
    setMentionOpen(true);
    setMentionQuery(ctx.query);
    setMentionStart(ctx.start);
    setMentionIndex(0);
  }, []);

  const handleMentionSelect = useCallback((item: MentionItem) => {
    const input = composerInputRef.current;
    if (!input) return;
    const cursor = input.selectionStart ?? draft.length;
    const start = mentionStart >= 0 ? mentionStart : draft.lastIndexOf('@', cursor);
    if (start < 0) return;
    const insert = `@${item.value || item.label}`;
    const next = `${draft.slice(0, start)}${insert} ${draft.slice(cursor)}`;
    setDraft(next);
    setMentionOpen(false);
    setMentionQuery('');
    setMentionStart(-1);
    requestAnimationFrame(() => {
      const nextCursor = start + insert.length + 1;
      input.focus();
      input.setSelectionRange(nextCursor, nextCursor);
    });
  }, [draft, mentionStart]);

  // Clear typing indicators on pod change so we never carry indicators from
  // another room into the current view.
  useEffect(() => {
    setTypingAgents([]);
    Object.values(typingAgentTimersRef.current).forEach(clearTimeout);
    typingAgentTimersRef.current = {};
  }, [pod?._id]);

  // Subscribe to agent typing events. Backend emits via agentTypingService;
  // safety timeout drops stale entries if a stop event is missed.
  useEffect(() => {
    const podId = pod?._id;
    if (!podId || !socket || !connected) return undefined;

    const keyFor = (p: { agentName?: string; instanceId?: string }) =>
      `${p?.agentName || ''}:${p?.instanceId || ''}`;
    const scheduleAutoStop = (key: string) => {
      if (typingAgentTimersRef.current[key]) clearTimeout(typingAgentTimersRef.current[key]);
      typingAgentTimersRef.current[key] = setTimeout(() => {
        setTypingAgents((prev) => prev.filter((a) => a.key !== key));
        delete typingAgentTimersRef.current[key];
      }, 30000);
    };

    interface TypingPayload {
      podId?: string;
      agentName?: string;
      username?: string;
      instanceId?: string;
      displayName?: string;
      avatar?: string;
      iconUrl?: string;
    }
    const handleStart = (payload: TypingPayload) => {
      if (!payload || (payload.podId && payload.podId !== podId)) return;
      const agentName = payload.agentName || payload.username;
      if (!agentName) return;
      // An agent typing in this pod falsifies "No agent was notified" — the
      // hint must not sit above a landing reply (#914).
      setAgentDeliveryHint(null);
      const key = keyFor({ agentName, instanceId: payload.instanceId });
      scheduleAutoStop(key);
      setTypingAgents((prev) => {
        const next: TypingAgentEntry = {
          key,
          agentName,
          instanceId: payload.instanceId,
          displayName: payload.displayName || payload.instanceId || agentName,
          avatar: payload.avatar || payload.iconUrl,
        };
        const exists = prev.find((a) => a.key === key);
        return exists ? prev.map((a) => (a.key === key ? next : a)) : [...prev, next];
      });
    };
    const handleStop = (payload: TypingPayload) => {
      const agentName = payload?.agentName || payload?.username;
      if (!agentName) return;
      const key = keyFor({ agentName, instanceId: payload.instanceId });
      if (typingAgentTimersRef.current[key]) {
        clearTimeout(typingAgentTimersRef.current[key]);
        delete typingAgentTimersRef.current[key];
      }
      setTypingAgents((prev) => prev.filter((a) => a.key !== key));
    };

    socket.on('agent_typing_start', handleStart);
    socket.on('agent_typing_stop', handleStop);
    return () => {
      socket.off('agent_typing_start', handleStart);
      socket.off('agent_typing_stop', handleStop);
      Object.values(typingAgentTimersRef.current).forEach(clearTimeout);
      typingAgentTimersRef.current = {};
    };
  }, [pod?._id, socket, connected]);

  // Click outside the mention dropdown closes it.
  useEffect(() => {
    if (!mentionOpen) return undefined;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (mentionDropdownRef.current && target && mentionDropdownRef.current.contains(target)) return;
      if (composerInputRef.current && target && composerInputRef.current.contains(target)) return;
      setMentionOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [mentionOpen]);

  // Avatar row shows active members only — humans (member.isBot=false)
  // plus currently-installed agents. pod.members[] retains stale bot
  // User rows for identity continuity (ADR-001 §3), so reading it raw
  // surfaces uninstalled agents in the avatar count. Mirrors the
  // V2PodInspector filter so the chat-header "+N" agrees with the
  // Members tab count. MUST live above the `if (!pod)` early return —
  // hooks run on every render or React fires #310 on pod-state changes.
  const activeMemberAgentUsernames = React.useMemo(() => {
    const set = new Set<string>();
    (agents || []).forEach((a) => {
      const rawName = ((a as { name?: string; agentName?: string }).name || a.agentName || '').toLowerCase();
      const inst = (a.instanceId || '').toLowerCase();
      const username = !inst || inst === 'default' || inst === rawName ? rawName : `${rawName}-${inst}`;
      if (username) set.add(username);
    });
    return set;
  }, [agents]);
  const effectiveMembers = React.useMemo(() => {
    // `isBot` is documented as unreliable on the wire (V2PodInspector
    // 804-807). A member whose `isBot` is falsy but whose username
    // matches an active agent would be counted twice without this
    // secondary guard.
    const humans = (members || []).filter((m) => {
      if (m.isBot) return false;
      return !activeMemberAgentUsernames.has((m.username || '').toLowerCase());
    });
    const activeAgentMembers = (members || []).filter((m) => (
      activeMemberAgentUsernames.has((m.username || '').toLowerCase())
    ));
    return [...humans, ...activeAgentMembers];
  }, [members, activeMemberAgentUsernames]);

  // Mobile-only hamburger: opens the pods slide-over drawer. CSS hides it on
  // desktop (>=761px) where the sidebar is a permanent column. Without it a
  // phone user who lands in a pod chat has no way back to the pod list.
  const mobileNavButton = onOpenMobileNav ? (
    <button
      type="button"
      className="v2-chat__mobile-nav-btn"
      onClick={onOpenMobileNav}
      title={t('podChat.mobile.showPods')}
      aria-label={t('podChat.mobile.showPodsList')}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 6h18M3 12h18M3 18h18" />
      </svg>
    </button>
  ) : null;

  if (!pod) {
    return (
      <main className="v2-pane v2-pane--main">
        {mobileNavButton && (
          <div className="v2-chat__header">
            <div className="v2-chat__header-row">{mobileNavButton}</div>
          </div>
        )}
        <div className="v2-empty">
          <div className="v2-empty__title">{t('podChat.empty.noPodTitle')}</div>
          <div className="v2-empty__text">{t('podChat.empty.noPodText')}</div>
        </div>
      </main>
    );
  }

  // §3.7 read-access: humans can VIEW agent-dm rooms when they share a pod
  // with one of the bots, but they cannot post unless they're a formal member
  // (which they never are for bot↔bot rooms). Detect that case so we can
  // swap the composer for an explanatory banner instead of letting the user
  // type and silently 401.
  const currentUserId = currentUser?._id || null;
  const isPodMember = !!currentUserId && (members || []).some(
    (m) => m && m._id === currentUserId,
  );
  const isAgentDm = pod.type === 'agent-dm';
  const isAgentRoom = pod.type === 'agent-room';
  const isReadOnly = isAgentDm && !isPodMember;

  // Bot-bot agent-dm — used to choose the "X and Y haven't talked yet" empty
  // state and to phrase the read-only banner appropriately.
  const botMembers = (members || []).filter((m) => m?.isBot);
  const isBotToBot = isAgentDm && botMembers.length >= 2 && botMembers.length === (members || []).length;
  const botPair = isBotToBot
    ? botMembers.slice(0, 2).map((m) => m.username || t('common.agent'))
    : null;

  const handleSend = async (override?: string) => {
    const text = (override ?? draft).trim();
    if (!text || sending) return;
    setSending(true);
    setComposerError(null);
    try {
      // reply_to and thread_root are mutually exclusive by construction here:
      // aimAtThread/aimAtMessage each clear the other, so at most one is set.
      // The resolver 400s a message carrying both rather than choosing.
      const created = await sendMessage(
        text,
        'text',
        replyTarget?.id || undefined,
        threadTarget?.id || undefined,
      );
      if (created) {
        const delivery = created.agentDelivery;
        const exampleAgent = agents.find((agent) => agent.status === 'active') || agents[0];
        // Same handle rule as the typeahead: human-chosen instanceId is the
        // identity and stays; an opaque per-user token must never be the
        // suggested handle ("Try @u3f9c2a1b7d") — persona displayName slug
        // first (@scout), then agentName.
        const rawMentionHandle = exampleAgent?.instanceId
          && exampleAgent.instanceId.toLowerCase() !== 'default'
          && !isOpaqueInstanceToken(exampleAgent.instanceId)
          ? exampleAgent.instanceId
          : (slugifyHandle(exampleAgent?.displayName || exampleAgent?.profile?.displayName)
            || exampleAgent?.agentName);
        const mentionHandle = normalizeAgentSegment(rawMentionHandle);
        if (
          delivery
          && delivery.enqueued === 0
          // A wake-on-message agent (the Guide in every fresh workspace) WAS
          // notified — "No agent was notified" would be false on screen while
          // it's already typing (#914).
          && (delivery.woken ?? 0) === 0
          && delivery.agentsInPod > 0
          && mentionHandle
        ) {
          const storageKey = `${AGENT_DELIVERY_HINT_KEY}.${pod._id}`;
          let alreadyShown = deliveryHintShownPodsRef.current.has(pod._id);
          try {
            alreadyShown = alreadyShown || sessionStorage.getItem(storageKey) === '1';
          } catch {
            // In-memory guard still prevents repeat hints in this mount.
          }
          if (!alreadyShown) {
            deliveryHintShownPodsRef.current.add(pod._id);
            try {
              sessionStorage.setItem(storageKey, '1');
            } catch {
              // sessionStorage unavailable; the in-memory guard still works.
            }
            setAgentDeliveryHint({ messageId: created.id, mentionHandle });
          }
        }
        setDraft('');
        setReplyTarget(null);
        // Cleared only on SUCCESS, alongside the draft. #1118's rule: a send
        // failure keeps the draft and its target, so a retry still lands in
        // the thread the user aimed at.
        setThreadTarget(null);
      }
    } finally {
      setSending(false);
    }
  };

  const handleStarterPrompt = (prompt: string) => {
    setDraft(prompt);
    setMentionOpen(false);
    requestAnimationFrame(() => {
      const input = composerInputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(prompt.length, prompt.length);
    });
  };

  // Composer attach: handles both images (sends as standalone image message,
  // legacy v2 behavior) and other file kinds (PDF / md / txt / csv / json,
  // inserts an [[upload:fileName|originalName|size|kind]] directive into the
  // draft so the user can add accompanying text and send when ready). Both
  // paths POST to /api/uploads with the active podId so the file shows up in
  // the inspector's Artifacts section.
  const handleAttachFile = async (file: File | null) => {
    if (!file || uploading) return;
    setUploading(true);
    setComposerError(null);
    try {
      const formData = new FormData();
      formData.append('image', file); // legacy multer field name
      formData.append('podId', pod._id);
      const uploaded = await api.post<{
        url?: string;
        fileName?: string;
        originalName?: string;
        size?: number;
        kind?: string;
      }>('/api/uploads', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      if (uploaded.kind === 'image' && uploaded.url) {
        await sendMessage(uploaded.url, 'image');
        return;
      }
      if (uploaded.fileName) {
        const directive = `[[upload:${uploaded.fileName}|${uploaded.originalName || file.name}|${uploaded.size || file.size}|${uploaded.kind || 'file'}]]`;
        setDraft((prev) => (prev ? `${prev.replace(/\s+$/, '')} ${directive}` : directive));
      }
    } catch (err) {
      const e = err as { response?: { data?: { msg?: string } } };
      setComposerError(e.response?.data?.msg || t('podChat.errors.uploadFailed'));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleSetMode = (next: PodMode) => {
    setMode(next);
    writeMode(pod._id, next);
  };

  // visibleMembers / memberCountExtra are plain consts derived from the
  // effectiveMembers useMemo that lives above the `if (!pod)` early
  // return — hooks must run on every render to satisfy the rules of
  // hooks (otherwise React #310 fires on pod-state transitions). Plain
  // consts can live here.
  const visibleMembers = effectiveMembers.slice(0, 3);
  const memberCountExtra = Math.max(0, effectiveMembers.length - visibleMembers.length);
  const onlineAgentCount = agents.filter((agent) => (
    !!agent.lastHeartbeatAt && Date.now() - new Date(agent.lastHeartbeatAt).getTime() < 10 * 60 * 1000
  )).length;
  const liveState = onlineAgentCount > 0
    ? t('podChat.heartbeat.recent', {
      count: onlineAgentCount,
      formattedCount: numberFormatter.format(onlineAgentCount),
    })
    : t('podChat.heartbeat.none');
  const starterPrompts = STARTER_PROMPT_KEYS.map((key) => t(key));

  return (
    <main className="v2-pane v2-pane--main">
      <div className="v2-chat">
        <header className="v2-chat__header">
          <div className="v2-chat__header-row">
            {mobileNavButton}
            <div className="v2-chat__title">
              <span className="v2-chat__title-mark">{podMarkFor(pod.name, pod.type, t('podChat.dmMark'))}</span>
              <span className="v2-chat__title-text">{pod.name}</span>
            </div>

            {onToggleInspector ? (
              <button
                type="button"
                className={`v2-chat__avatars v2-chat__avatars--button${inspectorCollapsed ? '' : ' v2-chat__avatars--active'}`}
                onClick={onToggleInspector}
                title={inspectorCollapsed ? t('podChat.team.view') : t('podChat.team.hide')}
                aria-label={inspectorCollapsed ? t('podChat.team.view') : t('podChat.team.hide')}
                aria-pressed={!inspectorCollapsed}
              >
                {visibleMembers.map((m) => (
                  <V2Avatar key={m._id || m.username} name={m.username} src={m.profilePicture || undefined} size="md" />
                ))}
                {memberCountExtra > 0 && (
                  <span className="v2-chat__avatars-more">+{memberCountExtra}</span>
                )}
              </button>
            ) : (
              <div className="v2-chat__avatars">
                {visibleMembers.map((m) => (
                  <V2Avatar key={m._id || m.username} name={m.username} src={m.profilePicture || undefined} size="md" />
                ))}
                {memberCountExtra > 0 && (
                  <span className="v2-chat__avatars-more">+{memberCountExtra}</span>
                )}
              </div>
            )}

            {/* Plan / Execute mode toggle — hidden until the pod-mode workflow
                ships end-to-end. Currently the toggle persists `mode` to the
                pod but no downstream surface uses it for behavior, so the
                control reads as broken — clicks land but nothing changes for
                the user. Re-enable when the mode actually drives behavior
                (agent autonomy gating, suggestion ranking, etc.). */}
            {false && (
              <div className={`v2-chat__mode-toggle v2-chat__mode-toggle--header v2-chat__mode-toggle--${mode}`} role="group" aria-label={t('podChat.mode.preference')}>
                <button
                  type="button"
                  className={`v2-chat__mode-option${mode === 'plan' ? ' v2-chat__mode-option--active' : ''}`}
                  onClick={() => handleSetMode('plan')}
                  aria-pressed={mode === 'plan'}
                  title={modeCopy('plan', t)}
                >
                  <Icon d="M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
                  {t('podChat.mode.plan')}
                </button>
                <button
                  type="button"
                  className={`v2-chat__mode-option${mode === 'execute' ? ' v2-chat__mode-option--active' : ''}`}
                  onClick={() => handleSetMode('execute')}
                  aria-pressed={mode === 'execute'}
                  title={modeCopy('execute', t)}
                >
                  <Icon d="M5 3l14 9-14 9V3z" />
                  {t('podChat.mode.execute')}
                </button>
              </div>
            )}

            {onOpenInvite && (
              <button
                type="button"
                className="v2-chat__icon-btn"
                onClick={() => onOpenInvite()}
                title={t('podChat.invite')}
                aria-label={t('podChat.invite')}
              >
                <Icon d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM20 8v6M17 11h6" />
              </button>
            )}

          </div>

          {pod.description && (
            <div className="v2-chat__goal">
              {pod.description}
              <span className="v2-chat__goal-meta"> · {liveState}</span>
            </div>
          )}
        </header>

        <div className="v2-chat__messages" ref={messagesContainerRef}>
          {hasMore && (
            <div className="v2-chat__older">
              <button
                type="button"
                className="v2-chat__older-btn"
                onClick={handleLoadOlder}
                disabled={loadingOlder}
              >
                {loadingOlder ? t('podChat.loadingOlder') : t('podChat.loadOlder')}
              </button>
            </div>
          )}
              {error && (
                <div className="v2-chat__error">
                  {error}
                </div>
              )}
              {loading && messages.length === 0 && (
                <div className="v2-empty"><span className="v2-spinner" /></div>
              )}
              {starterPanelVisible && pod && (
                <section className="v2-chat__new-pod" aria-label={t('podChat.newPod.label')}>
                  <div className="v2-chat__new-pod-head">
                    <div>
                      <div className="v2-chat__new-pod-title">{t('podChat.newPod.title')}</div>
                      <div className="v2-chat__new-pod-text">{t('podChat.newPod.text')}</div>
                    </div>
                    <button
                      type="button"
                      className="v2-chat__new-pod-dismiss"
                      aria-label={t('podChat.newPod.dismiss')}
                      onClick={() => clearJustCreatedPod(pod._id)}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M18 6L6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                  <div className="v2-chat__new-pod-actions">
                    <div className="v2-chat__new-pod-action v2-chat__new-pod-action--invite">
                      <div className="v2-chat__new-pod-action-title">{t('podChat.newPod.inviteTitle')}</div>
                      <div className="v2-chat__new-pod-action-text">{t('podChat.newPod.inviteText')}</div>
                      {starterInviteLoading && (
                        <div className="v2-chat__new-pod-status">{t('podChat.newPod.preparingInvite')}</div>
                      )}
                      {starterInviteUrl && (
                        <div className="v2-invite-link-row">
                          <input
                            type="text"
                            className="v2-invite-link"
                            aria-label={t('podChat.newPod.inviteLinkLabel')}
                            readOnly
                            value={starterInviteUrl}
                            onFocus={(event) => event.currentTarget.select()}
                          />
                          <button
                            type="button"
                            className="v2-chat__new-pod-copy"
                            onClick={() => { void handleStarterInviteCopy(); }}
                          >
                            {starterInviteCopied ? t('common.copied') : t('common.copy')}
                          </button>
                        </div>
                      )}
                      {starterInviteError && (
                        <div className="v2-chat__new-pod-error">
                          <span>{starterInviteError}</span>
                          <button
                            type="button"
                            onClick={() => { void generateStarterInvite(pod._id); }}
                          >
                            {t('podChat.newPod.tryAgain')}
                          </button>
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      className="v2-chat__new-pod-action"
                      onClick={() => onOpenInvite?.('agent')}
                    >
                      <span className="v2-chat__new-pod-action-title">{t('podChat.newPod.addAgentTitle')}</span>
                      <span className="v2-chat__new-pod-action-text">{t('podChat.newPod.addAgentText')}</span>
                    </button>
                    <button
                      type="button"
                      className="v2-chat__new-pod-action"
                      onClick={() => composerInputRef.current?.focus()}
                    >
                      <span className="v2-chat__new-pod-action-title">{t('podChat.newPod.messageTitle')}</span>
                      <span className="v2-chat__new-pod-action-text">{t('podChat.newPod.messageText')}</span>
                    </button>
                  </div>
                </section>
              )}
              {!starterPanelVisible && !firstRunVisible && !loading && messages.length === 0 && (
                <div className="v2-empty">
                  {isBotToBot && botPair ? (
                    <>
                      <div className="v2-empty__title">{t('podChat.empty.botPairTitle', { first: botPair[0], second: botPair[1] })}</div>
                      <div className="v2-empty__text">{t('podChat.empty.botPairText')}</div>
                    </>
                  ) : isAgentRoom && botMembers.length === 1 ? (
                    (() => {
                      const rawUsername = botMembers[0]?.username || '';
                      const agentName = agentDisplayNames.get(rawUsername.toLowerCase())
                        || rawUsername
                        || t('common.agent');
                      return (
                        <>
                          <div className="v2-empty__title">{t('podChat.empty.agentRoomTitle', { agentName })}</div>
                          <div className="v2-empty__text">
                            {t('podChat.empty.agentRoomText')}
                          </div>
                        </>
                      );
                    })()
                  ) : isAgentDm ? (
                    <>
                      <div className="v2-empty__title">{t('podChat.empty.noMessagesTitle')}</div>
                      <div className="v2-empty__text">{t('podChat.empty.agentDmText')}</div>
                    </>
                  ) : (
                    <>
                      <div className="v2-empty__title">{t('podChat.empty.quietTitle')}</div>
                      <div className="v2-empty__text">
                        {t('podChat.empty.quietText')}
                      </div>
                    </>
                  )}
                </div>
              )}
              {buildThreadView(messages, threadState.byRoot).map((item, i, view) => {
                if (item.kind === 'message') {
                  const m = item.message;
                  const prev = view[i - 1];
                  return (
                    <React.Fragment key={m.id}>
                      <V2MessageBubble
                        message={m}
                        agentDisplayNames={agentDisplayNames}
                        agentAuthorKeys={agentAuthorKeys}
                        onAuthorClick={onOpenMember ? handleAuthorClick : undefined}
                        onOpenFile={onOpenFile}
                        onReply={aimAtMessage}
                        grouped={isGroupedWithPrevious(
                          m,
                          prev && prev.kind === 'message' ? prev.message : undefined,
                        )}
                      />
                      {agentDeliveryHint?.messageId === m.id && (
                        <div className="v2-chat__delivery-hint" role="status">
                          <Trans
                            i18nKey="podChat.deliveryHint"
                            values={{ handle: agentDeliveryHint.mentionHandle }}
                            components={{ handle: <strong /> }}
                          />
                        </div>
                      )}
                    </React.Fragment>
                  );
                }

                const st = threadState.byRoot.get(item.rootId);
                // No state row means the server does not consider this a
                // thread. Render the replies flat rather than inventing a
                // collapsed card around them — absence is not "collapsed".
                const collapsed = st ? st.collapsed : false;
                return (
                  <React.Fragment key={`thread-${item.rootId}`}>
                    <V2ThreadCard
                      replyCount={item.replyCount}
                      participants={item.participants}
                      lastActivityAt={item.lastActivityAt}
                      collapsed={collapsed}
                      following={st ? st.following : null}
                      onToggleCollapsed={() => threadState.toggleCollapsed(item.rootId)}
                      onToggleFollowing={() => threadState.toggleFollowing(item.rootId)}
                    />
                    {!collapsed && (
                      <div className="v2-thread-replies">
                        {item.replies.map((r, ri) => (
                          <V2MessageBubble
                            key={r.id}
                            message={r}
                            agentDisplayNames={agentDisplayNames}
                            agentAuthorKeys={agentAuthorKeys}
                            onAuthorClick={onOpenMember ? handleAuthorClick : undefined}
                            onOpenFile={onOpenFile}
                            onReply={aimAtMessage}
                            grouped={isGroupedWithPrevious(r, item.replies[ri - 1])}
                          />
                        ))}
                        {!isReadOnly && (
                          <button
                            type="button"
                            className="v2-thread-replies__aim"
                            onClick={() => aimAtThread(
                              item.rootId,
                              String(messages.find((x) => String(x.id) === item.rootId)?.content || ''),
                            )}
                          >
                            {t('podChat.thread.replyInThread')}
                          </button>
                        )}
                      </div>
                    )}
                  </React.Fragment>
                );
              })}
              <div ref={messagesEndRef} />
            </div>

            <TypingIndicator agents={typingAgents} />

            {!isReadOnly
              && (isAgentRoom || isAgentDm)
              && !loading
              && messages.length === 0
              && !firstRunVisible
              && !draft.trim() && (
                <div className="v2-chat__starter-prompts" role="group" aria-label={t('podChat.starters.label')}>
                  {starterPrompts.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      className="v2-chat__starter-prompt"
                      onClick={() => handleStarterPrompt(prompt)}
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
            )}

            {isReadOnly ? (
              <div className="v2-chat__readonly" role="note" aria-label={t('podChat.readOnly.label')}>
                <div className="v2-chat__readonly-icon" aria-hidden="true">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0110 0v4" />
                  </svg>
                </div>
                <div className="v2-chat__readonly-body">
                  <div className="v2-chat__readonly-title">{t('podChat.readOnly.title')}</div>
                  <div className="v2-chat__readonly-text">
                    {isBotToBot && botPair
                      ? t('podChat.readOnly.botPair', { first: botPair[0], second: botPair[1] })
                      : t('podChat.readOnly.agentDm')}
                  </div>
                </div>
              </div>
            ) : (
            <div className="v2-chat__composer">
              {threadTarget && (
                <div className="v2-chat__reply-chip v2-chat__reply-chip--thread" role="status">
                  <span className="v2-chat__reply-chip-label">
                    {t('podChat.thread.replyingInThread')}{' '}
                    {threadTarget.preview.replace(/\[\[upload:[^\]]*\]\]/g, '📎').slice(0, 40)}
                  </span>
                  <button
                    type="button"
                    className="v2-chat__reply-chip-cancel"
                    aria-label={t('podChat.cancelReply')}
                    onClick={() => setThreadTarget(null)}
                  >
                    {CLOSE_MARK}
                  </button>
                </div>
              )}
              {replyTarget && (
                <div className="v2-chat__reply-chip" role="status">
                  <span className="v2-chat__reply-chip-label">
                    <Trans
                      i18nKey="podChat.replyingTo"
                      values={{ author: replyTarget.user?.username || t('podChat.messageFallback') }}
                      components={{ author: <strong /> }}
                    />{' '}
                    {String(replyTarget.content || '').replace(/\[\[upload:[^\]]*\]\]/g, '📎').slice(0, 80)}
                  </span>
                  <button
                    type="button"
                    className="v2-chat__reply-chip-cancel"
                    aria-label={t('podChat.cancelReply')}
                    onClick={() => setReplyTarget(null)}
                  >
                    {CLOSE_MARK}
                  </button>
                </div>
              )}
              <div className="v2-chat__composer-input-wrap">
                <textarea
                  ref={composerInputRef}
                  className="v2-chat__composer-input"
                  placeholder={t('podChat.composer.placeholder', { podName: pod.name })}
                  value={draft}
                  onChange={(e) => {
                    const next = e.target.value;
                    setDraft(next);
                    updateMentionState(next, e.target.selectionStart);
                  }}
                  onClick={(e) => updateMentionState(
                    (e.target as HTMLTextAreaElement).value,
                    (e.target as HTMLTextAreaElement).selectionStart,
                  )}
                  onKeyUp={(e) => updateMentionState(
                    (e.target as HTMLTextAreaElement).value,
                    (e.target as HTMLTextAreaElement).selectionStart,
                  )}
                  onKeyDown={(e) => {
                    if (mentionOpen && filteredMentions.length > 0) {
                      if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        setMentionIndex((p) => (p + 1) % filteredMentions.length);
                        return;
                      }
                      if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        setMentionIndex((p) => (p - 1 + filteredMentions.length) % filteredMentions.length);
                        return;
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        setMentionOpen(false);
                        return;
                      }
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        const sel = filteredMentions[mentionIndex];
                        if (sel) handleMentionSelect(sel);
                        return;
                      }
                    }
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  rows={2}
                />
                {mentionOpen && filteredMentions.length > 0 && (
                  <div className="v2-mention-dropdown" ref={mentionDropdownRef} role="listbox">
                    {filteredMentions.map((item, idx) => (
                      <button
                        type="button"
                        key={item.id}
                        className={`v2-mention-item${idx === mentionIndex ? ' v2-mention-item--active' : ''}`}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => handleMentionSelect(item)}
                        role="option"
                        aria-selected={idx === mentionIndex}
                      >
                        <V2Avatar name={item.label} src={item.avatar || undefined} size="sm" />
                        <span className="v2-mention-item__text">
                          <span className="v2-mention-item__label">@{item.value || item.label}</span>
                          <span className="v2-mention-item__sub">{item.subtitle}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                <div className="v2-chat__composer-actions">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*,.pdf,.md,.txt,.csv,.json,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp,.zip"
                    style={{ display: 'none' }}
                    onChange={(e) => handleAttachFile(e.target.files?.[0] || null)}
                  />
                  <button
                    type="button"
                    className="v2-chat__composer-icon-btn"
                    title={uploading ? t('podChat.composer.uploading') : t('podChat.composer.attachFile')}
                    aria-label={t('podChat.composer.attachFile')}
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                  >
                    <Icon d="M21 11l-9 9a5 5 0 01-7-7l9-9a3 3 0 014 4l-9 9a1 1 0 01-2-2l8-8" />
                  </button>
                </div>
                <button
                  type="button"
                  className={`v2-chat__send v2-chat__send--${mode}`}
                  onClick={() => handleSend()}
                  disabled={sending || !draft.trim()}
                  title={sending ? t('podChat.composer.sending') : t('podChat.composer.send')}
                  aria-label={sending ? t('podChat.composer.sending') : t('podChat.composer.send')}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M2.5 11.4 21.2 3.1c.6-.3 1.2.3.9.9L13.8 22.7c-.3.6-1.2.6-1.4-.1l-2.7-7.4-7.4-2.7c-.7-.2-.7-1.1.2-1.1z" />
                  </svg>
                </button>
              </div>
              {(composerError || sendError) && (
                <div className="v2-chat__composer-footer">
                  <span className="v2-chat__composer-error">{composerError || sendError}</span>
                </div>
              )}
              {unreachableMentioned.length > 0 && (
                <div className="v2-chat__composer-footer" data-testid="mention-state-warning">
                  {unreachableMentioned.map((row) => (
                    <span key={row.agentName} className="v2-chat__composer-hint">
                      {row.state === 'never-connected'
                        ? (row.fixCommand
                          ? t('podChat.mentionState.neverOwner', { handle: row.agentName, command: row.fixCommand })
                          : t('podChat.mentionState.neverPeer', { handle: row.agentName }))
                        : (row.fixCommand
                          ? t('podChat.mentionState.darkOwner', { handle: row.agentName, command: row.fixCommand })
                          : t('podChat.mentionState.darkPeer', { handle: row.agentName }))}
                    </span>
                  ))}
                </div>
              )}
              <div className="v2-chat__composer-hint">
                <span><kbd>@</kbd> {t('podChat.composer.mentionAgent')}</span>
                <span><kbd>{COMMAND_KEY}</kbd><kbd>{ENTER_KEY}</kbd> {t('podChat.composer.toSend')}</span>
              </div>
            </div>
            )}
      </div>
    </main>
  );
};

export default V2PodChat;
