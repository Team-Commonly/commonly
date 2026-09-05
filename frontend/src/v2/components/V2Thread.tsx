import React, {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import V2Avatar from './V2Avatar';
import V2CatchUpStrip from './V2CatchUpStrip';
import V2Composer from './V2Composer';
import { type V2DecisionCardData } from './V2DecisionCard';
import V2ThreadMessages from './V2ThreadMessages';
import V2ThreadStarter from './V2ThreadStarter';
import {
  UseV2PodDetailResult,
} from '../hooks/useV2PodDetail';
import { useV2Api } from '../hooks/useV2Api';
import { UseV2PodsResult } from '../hooks/useV2Pods';
import { useSocket } from '../../context/SocketContext';
import { useAuth } from '../../context/AuthContext';
import { useTranslation } from 'react-i18next';
import type { V2InviteTab } from './V2InviteModal';

import { useV2ThreadState } from '../hooks/useV2ThreadState';
import { useV2ThreadMentions } from '../hooks/useV2ThreadMentions';
import { buildThreadView } from '../utils/threadView';
import { agentKeyFor } from '../utils/agentKey';
import {
  buildAgentUsername,
  isOpaqueInstanceToken,
  normalizeAgentSegment,
  slugifyAgentHandle,
} from '../utils/threadAgentIdentity';

const AGENT_DELIVERY_HINT_KEY = 'v2.agentDeliveryHint';
const JUST_CREATED_POD_KEY = 'v2.justCreated';
const AGENT_INVITE_TAB: V2InviteTab = 'agent';
// A sent direct message is durable in the room, but it is not a reply. Give
// the person a clear, bounded wait state instead of leaving the composer to
// imply that the agent is working. Two minutes is long enough for a normal
// turn and short enough to make an unavailable seat visible.
const AGENT_REPLY_TIMEOUT_MS = 2 * 60 * 1000;

const STARTER_PROMPT_KEYS = [
  'podChat.starters.introduce',
  'podChat.starters.help',
  'podChat.starters.firstQuestion',
] as const;

// #891 surface 1 — per-agent reachability from /api/pods/:podId/agent-states.
// Only the states the kernel can derive HONESTLY for the agent's runtime
// class arrive here. Shared-pod mention affordances stay quiet for
// 'reachable'/'unknown'; a 1:1 room separately states returned uncertainty.
type AgentReachState = 'listening' | 'gone-dark' | 'never-connected' | 'reachable' | 'unknown';
interface AgentStateRow {
  agentName: string;
  instanceId: string;
  displayName?: string;
  state: AgentReachState;
  isOwner: boolean;
  fixCommand?: string;
}
const REACH_IS_ACTIVE = new Set<AgentReachState>(['listening', 'reachable']);

interface DirectAgentIdentity {
  username: string;
  displayName: string;
  state: AgentStateRow | null;
}

interface AwaitingAgentReply {
  podId: string;
  messageId: string;
  agentName: string;
  sentAt: number;
  timedOut: boolean;
}

interface TypingAgentEntry {
  key: string;
  agentName: string;
  instanceId?: string;
  displayName: string;
  avatar?: string;
}

interface ThreadDecision extends V2DecisionCardData {
  kind: 'decision';
  podId: string;
  messageId: string;
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

interface V2ThreadProps {
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
  // to V2MessageRow → FilePill so the click opens the inspector
  // artifact preview instead of window.open()'ing a raw file in a new tab.
  onOpenFile?: (fileName: string) => void;
  // Opens the mobile pods drawer (<=760px). The hamburger in the chat header
  // is the primary way back to the pod list on phones, where the sidebar is
  // an overlay rather than a visible column. Hidden via CSS on desktop.
  onOpenMobileNav?: () => void;
}

const V2Thread: React.FC<V2ThreadProps> = ({ detail, firstRunVisible = false, inspectorCollapsed, onToggleInspector, onOpenMember, onOpenInvite, onOpenFile, onOpenMobileNav }) => {
  const { t } = useTranslation();
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
  const [awaitingAgentReply, setAwaitingAgentReply] = useState<AwaitingAgentReply | null>(null);
  const deliveryHintShownPodsRef = useRef<Set<string>>(new Set());
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
  const aimAtMessageThread = useCallback((m: import('../hooks/useV2PodDetail').V2Message) => {
    // The action is available on every visible message, including replies.
    // Explicit roots may not themselves be inside a thread (#1128), so a
    // reply joins its existing root while a standalone message starts one.
    const rootId = String(m.thread_root_id ?? m.id);
    const root = messages.find((candidate) => String(candidate.id) === rootId);
    aimAtThread(rootId, String(root?.content || m.content || ''));
  }, [aimAtThread, messages]);

  // Memoized: it was called in the render body, so every keystroke in the
  // composer re-folded the whole message list. @sprint-review on #1150.
  // Recomputes only when the messages or the thread state actually change.
  const threadView = useMemo(
    () => buildThreadView(messages, threadState.byRoot),
    [messages, threadState.byRoot],
  );

  // #891 surface 1: agent reachability at the moment of composing a mention.
  // Best-effort — a failed read renders nothing rather than something wrong,
  // and 60s refresh keeps the states honest without hammering the endpoint.
  const [agentStates, setAgentStates] = useState<AgentStateRow[]>([]);
  const [decisions, setDecisions] = useState<ThreadDecision[]>([]);

  // A DecisionRequest posts an ordinary message for its timeline position and
  // materializes its typed choices in the attention queue. Join those two
  // durable records by messageId; never infer a card from agent prose.
  useEffect(() => {
    const podId = pod?._id;
    if (!podId) {
      setDecisions([]);
      return undefined;
    }
    let active = true;
    const load = async () => {
      try {
        const data = await api.get<{ items?: ThreadDecision[] }>('/api/activity/decision-queue');
        if (!active) return;
        setDecisions((data?.items || []).filter((item) => (
          item.kind === 'decision'
          && item.podId === podId
          && typeof item.messageId === 'string'
          && item.messageId.length > 0
          && Array.isArray(item.options)
          && item.options.length > 0
        )));
      } catch {
        // A queue read is additive decoration: preserve a working thread when
        // attention is temporarily unavailable rather than inventing cards.
        if (active) setDecisions([]);
      }
    };
    void load();
    const timer = window.setInterval(load, 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [api, pod?._id]);

  const decisionByMessageId = useMemo(() => new Map(
    decisions.map((decision) => [String(decision.messageId), decision]),
  ), [decisions]);

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

  const {
    mentionOpen,
    setMentionOpen,
    mentionIndex,
    setMentionIndex,
    filteredMentions,
    warnings: mentionWarnings,
    updateMentionState,
    selectMention,
  } = useV2ThreadMentions({
    members,
    agents,
    agentStateByHandle,
    draft,
    setDraft,
    inputRef: composerInputRef,
  });

  // Agent rooms are exactly one human and one agent. Resolve that one agent
  // through the same installation data that powers mentions, then attach the
  // liveness row only when the status endpoint returned a matching row. An
  // unavailable status read must never turn into a fabricated "offline" UI.
  const directAgent = useMemo<DirectAgentIdentity | null>(() => {
    if (pod?.type !== 'agent-room') return null;
    // `isBot` is not reliable on every old member payload. Prefer a member
    // that resolves against the active agent installation, then keep isBot as
    // the backwards-compatible fallback.
    const member = (members || []).find((candidate) => (agents || []).some((agent) => {
      const rawName = ((agent as { name?: string; agentName?: string }).name || agent.agentName || '');
      return buildAgentUsername(rawName, agent.instanceId) === (candidate?.username || '').toLowerCase();
    })) || (members || []).find((candidate) => candidate?.isBot);
    if (!member) return null;
    const username = (member.username || '').toLowerCase();
    const agent = (agents || []).find((candidate) => {
      const rawName = ((candidate as { name?: string; agentName?: string }).name || candidate.agentName || '');
      return buildAgentUsername(rawName, candidate.instanceId) === username;
    });
    const rawName = ((agent as { name?: string; agentName?: string } | undefined)?.name
      || agent?.agentName
      || username);
    const rawInstance = agent?.instanceId || '';
    const state = agentStateByHandle.get(rawInstance.toLowerCase())
      || agentStateByHandle.get(rawName.toLowerCase())
      || null;
    return {
      username,
      displayName: agent?.displayName || agent?.profile?.displayName || state?.displayName || member.username || t('common.agent'),
      state,
    };
  }, [pod?.type, members, agents, agentStateByHandle, t]);

  // The direct-room wait ends only on the agent's actual reply (not when the
  // POST succeeds) or after a bounded timeout. Clearing it on a pod change
  // keeps a wait from one room from leaking into another.
  useEffect(() => {
    if (!awaitingAgentReply) return undefined;
    if (pod?._id !== awaitingAgentReply.podId) {
      setAwaitingAgentReply(null);
      return undefined;
    }
    const receivedReply = messages.some((message) => {
      if (String(message.id) === awaitingAgentReply.messageId) return false;
      const sentOrLater = new Date(message.created_at || message.createdAt || 0).getTime()
        >= awaitingAgentReply.sentAt;
      const isDirectAgent = Boolean(message.user?.isBot)
        || String(message.user?.username || '').toLowerCase() === directAgent?.username;
      return sentOrLater && isDirectAgent;
    });
    if (receivedReply) {
      setAwaitingAgentReply(null);
      return undefined;
    }
    if (awaitingAgentReply.timedOut) return undefined;
    const remaining = Math.max(0, AGENT_REPLY_TIMEOUT_MS - (Date.now() - awaitingAgentReply.sentAt));
    const timeout = setTimeout(() => {
      setAwaitingAgentReply((current) => (
        current && current.messageId === awaitingAgentReply.messageId
          ? { ...current, timedOut: true }
          : current
      ));
    }, remaining);
    return () => clearTimeout(timeout);
  }, [awaitingAgentReply, pod?._id, messages, directAgent?.username]);

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
  // '<agentName>-<instanceId>'. Lets V2MessageRow render "Engineer (Nova)"
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
      // Shared composite key (agentKey.ts): instanceId alone collapsed every
      // 'default'-instance fleet seat onto one key, so every author click
      // opened the same member's profile (Sam, 2026-08-26).
      const key = agentKeyFor(agent);
      if (!rawName) continue;
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
  const directAgentReach = directAgent?.state?.state;
  const showDirectAgentLiveness = Boolean(
    isAgentRoom && directAgent && directAgentReach && !REACH_IS_ACTIVE.has(directAgentReach),
  );
  const directAgentLivenessKey = directAgentReach === 'never-connected'
    ? 'podChat.agentRoomLiveness.neverConnected'
    : directAgentReach === 'gone-dark'
      ? 'podChat.agentRoomLiveness.goneDark'
      : 'podChat.agentRoomLiveness.unknown';
  const showAwaitingAgentReply = Boolean(
    isAgentRoom && awaitingAgentReply && awaitingAgentReply.podId === pod._id,
  );

  const handleSend = async (override?: string) => {
    const text = (override ?? draft).trim();
    if (!text || sending) return;
    setSending(true);
    setComposerError(null);
    try {
      // reply_to and thread_root are mutually exclusive by construction here:
      // aimAtThread/aimAtMessage each clear the other, so at most one is set.
      //
      // The reason is SEMANTIC, not that the backend would refuse the pair.
      // It would not: resolveThreadRoot 400s only when the two DISAGREE
      // (thread_root_mismatch) and accepts them when they agree. An in-thread
      // post must carry no addressing edge because a reply edge pings the
      // author of whatever it points at (@ux-lead 56879) — that is the rule
      // this enforces, and it is the client's to keep.
      //
      // "Agree" is a set, not a point: the backend accepts the pair whenever
      // explicit === COALESCE(parent.thread_root_id, parent.id), i.e. whenever
      // the parent is anywhere IN the thread being aimed at. Two members, and
      // they differ in WHO gets pinged, because resolveImplicitReplyTarget
      // resolves the author of replyToMessageId — the parent, not the root:
      //   parent mid-thread (reply 101 in thread 100) -> pings 101's author
      //   parent IS the root (replyTo 100, root 100)  -> pings the root's author
      // Only the second collapses onto "the root's author", which is why that
      // is the shape this comment is really about — and it is structurally
      // unrefusable: a root's COALESCE falls through to its own id, so the two
      // statements can never disagree. @sprint-review 56879.
      const created = await sendMessage(
        text,
        'text',
        replyTarget?.id || undefined,
        threadTarget?.id || undefined,
      );
      if (created) {
        // A direct-room post is not evidence that the agent is alive or
        // working. Track the reply separately so the user gets a truthful
        // "waiting" state until the agent speaks or the wait expires.
        if (isAgentRoom && directAgent) {
          setAwaitingAgentReply({
            podId: pod._id,
            messageId: String(created.id),
            agentName: directAgent.displayName,
            sentAt: Date.now(),
            timedOut: false,
          });
        }
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
          : (slugifyAgentHandle(exampleAgent?.displayName || exampleAgent?.profile?.displayName)
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
        // BOTH targets, and consumed on success — the image path is a second
        // send site and has now been half-updated twice. #1150 gave it the
        // thread root and left `replyTarget` hardcoded undefined (@ux-lead
        // 57473), so aiming at a person and uploading posted the picture
        // unrouted while the chip still read "Replying to {name}". And it
        // never cleared its targets, so the aim survived a completed send and
        // silently applied to the next one.
        //
        // Safe by construction rather than by care: aimAtThread and
        // aimAtMessage each clear the other, so the two can never both be set
        // and the resolver never sees a pair.
        //
        // The rule the ruling states is "a send consumes the target on EVERY
        // path" — written that way precisely because per-path wiring is what
        // keeps going wrong here.
        const created = await sendMessage(
          uploaded.url,
          'image',
          replyTarget?.id || undefined,
          threadTarget?.id || undefined,
        );
        if (created) {
          setReplyTarget(null);
          setThreadTarget(null);
        }
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

  const onlineAgentCount = agents.filter((agent) => (
    !!agent.lastHeartbeatAt && Date.now() - new Date(agent.lastHeartbeatAt).getTime() < 10 * 60 * 1000
  )).length;
  const starterPrompts = STARTER_PROMPT_KEYS.map((key) => t(key));

  return (
    <main className="v2-pane v2-pane--main">
      <div className="v2-chat">
        <header className="v2-thread__header">
          <div className="v2-thread__header-row">
            {mobileNavButton}
            <div className="v2-thread__title">
              <h1>{pod.name}</h1>
              {pod.description && <p>{pod.description}</p>}
            </div>
            {onToggleInspector ? (
              <button
                type="button"
                className={`v2-thread__working${inspectorCollapsed ? '' : ' v2-thread__working--active'}`}
                onClick={onToggleInspector}
                title={inspectorCollapsed ? t('podChat.team.view') : t('podChat.team.hide')}
                aria-label={inspectorCollapsed ? t('podChat.team.view') : t('podChat.team.hide')}
                aria-pressed={!inspectorCollapsed}
              >
                {t('podChat.header.agentsWorking', { count: onlineAgentCount })}
              </button>
            ) : (
              <span className="v2-thread__working">{t('podChat.header.agentsWorking', { count: onlineAgentCount })}</span>
            )}
          </div>
        </header>

        <V2CatchUpStrip podId={pod._id} />

        <V2ThreadMessages
          messages={messages}
          threadView={threadView}
          threadState={threadState}
          decisionByMessageId={decisionByMessageId}
          agentDisplayNames={agentDisplayNames}
          agentAuthorKeys={agentAuthorKeys}
          onAuthorClick={onOpenMember ? handleAuthorClick : undefined}
          onOpenFile={onOpenFile}
          onReply={isReadOnly ? undefined : aimAtMessage}
          onThread={isReadOnly ? undefined : aimAtMessageThread}
          onAimAtThread={aimAtThread}
          hasMore={hasMore}
          loadingOlder={loadingOlder}
          onLoadOlder={() => { void handleLoadOlder(); }}
          loading={loading}
          error={error}
          starterPanel={starterPanelVisible ? (
            <V2ThreadStarter
              inviteUrl={starterInviteUrl}
              inviteLoading={starterInviteLoading}
              inviteError={starterInviteError}
              inviteCopied={starterInviteCopied}
              onDismiss={() => clearJustCreatedPod(pod._id)}
              onCopyInvite={() => { void handleStarterInviteCopy(); }}
              onRetryInvite={() => { void generateStarterInvite(pod._id); }}
              onOpenInvite={() => onOpenInvite?.(AGENT_INVITE_TAB)}
              onFocusComposer={() => composerInputRef.current?.focus()}
            />
          ) : undefined}
          emptyState={!starterPanelVisible && !firstRunVisible && !loading && messages.length === 0 ? (
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
          ) : undefined}
          agentDeliveryHint={agentDeliveryHint}
          messagesContainerRef={messagesContainerRef}
          messagesEndRef={messagesEndRef}
        />

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
            <>
              {showDirectAgentLiveness && directAgent && (
                <div className="v2-chat__agent-room-status" data-testid="agent-room-liveness" role="status">
                  {t(directAgentLivenessKey, { agentName: directAgent.displayName })}
                </div>
              )}
              {showAwaitingAgentReply && awaitingAgentReply && (
                <div
                  className={`v2-chat__agent-room-status v2-chat__agent-room-status--wait${awaitingAgentReply.timedOut ? ' v2-chat__agent-room-status--timeout' : ''}`}
                  data-testid="agent-reply-wait"
                  role="status"
                >
                  {!awaitingAgentReply.timedOut && <span className="v2-chat__agent-room-status-dot" aria-hidden="true" />}
                  {awaitingAgentReply.timedOut
                    ? t('podChat.agentRoomLiveness.timedOut', { agentName: awaitingAgentReply.agentName })
                    : t('podChat.agentRoomLiveness.waiting', { agentName: awaitingAgentReply.agentName })}
                </div>
              )}
              <V2Composer
                podName={pod.name}
                authorName={currentUser?.username || t('common.you')}
                draft={draft}
                sending={sending}
                uploading={uploading}
                composerError={composerError}
                sendError={sendError}
                replyTarget={replyTarget}
                threadTarget={threadTarget}
                mentionOpen={mentionOpen}
                mentionIndex={mentionIndex}
                mentions={filteredMentions}
                warnings={mentionWarnings}
                inputRef={composerInputRef}
                fileInputRef={fileInputRef}
                mentionDropdownRef={mentionDropdownRef}
                onDraftChange={(next, cursor) => {
                  setDraft(next);
                  updateMentionState(next, cursor);
                }}
                onDraftPointer={updateMentionState}
                onKeyDown={(event) => {
                  if (mentionOpen && filteredMentions.length > 0) {
                    if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      setMentionIndex((index) => (index + 1) % filteredMentions.length);
                      return;
                    }
                    if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      setMentionIndex((index) => (index - 1 + filteredMentions.length) % filteredMentions.length);
                      return;
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      setMentionOpen(false);
                      return;
                    }
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      const selection = filteredMentions[mentionIndex];
                      if (selection) selectMention(selection);
                      return;
                    }
                  }
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void handleSend();
                  }
                }}
                onMentionSelect={selectMention}
                onSend={() => { void handleSend(); }}
                onAttach={(file) => { void handleAttachFile(file); }}
                onCancelReply={() => setReplyTarget(null)}
                onCancelThread={() => setThreadTarget(null)}
              />
            </>
            )}
      </div>
    </main>
  );
};

export default V2Thread;
