import React, {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { useLocation, useNavigate } from 'react-router-dom';
import ViewSidebarOutlinedIcon from '@mui/icons-material/ViewSidebarOutlined';
import V2Avatar from './V2Avatar';
import V2CatchUpStrip from './V2CatchUpStrip';
import V2Composer from './V2Composer';
import { type V2DecisionCardData, type V2DecisionRuling } from './V2DecisionCard';
import V2ThreadMessages, { V2ThreadHistoryStatus } from './V2ThreadMessages';
import { landOnMessage } from './V2MessageRow';
import V2ThreadStarter from './V2ThreadStarter';
import {
  HistorySearchState,
  UseV2PodDetailResult,
} from '../hooks/useV2PodDetail';
import { useV2Api } from '../hooks/useV2Api';
import { useV2PodHeaderMeta } from '../hooks/useV2PodHeaderMeta';
import { UseV2PodsResult } from '../hooks/useV2Pods';
import { useSocket } from '../../context/SocketContext';
import { useAuth } from '../../context/AuthContext';
import { useTranslation } from 'react-i18next';
import type { V2InviteTab } from './V2InviteModal';

import { useV2ThreadState } from '../hooks/useV2ThreadState';
import { useV2ThreadMentions } from '../hooks/useV2ThreadMentions';
import { buildThreadView, freezeOrphanReplyIds } from '../utils/threadView';
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
  status?: 'pending' | 'ruled';
  ruling?: V2DecisionRuling | null;
}

interface DecisionPage<T> {
  items?: T[];
  hasMore?: boolean;
}

const DECISION_PAGE_SIZE = 50;
const DECISION_MESSAGE_ID_BATCH_SIZE = 200;

const loadDecisionPages = async <T,>(
  api: ReturnType<typeof useV2Api>,
  endpoint: string,
  podId: string,
  extraParams: Record<string, string> = {},
): Promise<{ items: T[] }> => {
  const items: T[] = [];
  let offset = 0;
  // A malformed response must not create an unbounded request loop. The
  // server caps each page at 50; 100 pages is ample for a room while still
  // bounding a broken hasMore implementation.
  for (let page = 0; page < 100; page += 1) {
    const data = await api.get<DecisionPage<T>>(endpoint, {
      params: {
        podId, limit: DECISION_PAGE_SIZE, offset, ...extraParams,
      },
    });
    const pageItems = Array.isArray(data?.items) ? data.items : [];
    items.push(...pageItems);
    if (!data?.hasMore || pageItems.length === 0) break;
    offset += pageItems.length;
  }
  return { items };
};

const loadDecisionPagesForMessageIds = async <T,>(
  api: ReturnType<typeof useV2Api>,
  endpoint: string,
  podId: string,
  messageIds: string[],
): Promise<{ items: T[] }> => {
  const uniqueMessageIds = [...new Set(messageIds.filter(Boolean))];
  const batches: string[][] = [];
  for (let index = 0; index < uniqueMessageIds.length; index += DECISION_MESSAGE_ID_BATCH_SIZE) {
    batches.push(uniqueMessageIds.slice(index, index + DECISION_MESSAGE_ID_BATCH_SIZE));
  }
  // An empty transcript still sends one explicit empty filter. This keeps the
  // read authoritative (and preserves the existing empty-state behavior),
  // while every non-empty filter stays under the server's documented cap.
  if (batches.length === 0) batches.push([]);
  const pages = await Promise.all(batches.map((batch) => loadDecisionPages<T>(
    api,
    endpoint,
    podId,
    { messageIds: batch.join(',') },
  )));
  return { items: pages.flatMap((page) => page.items) };
};

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
  // Phone only (<=760px): the pods list is a page and a pod is the next page,
  // so the header carries a back control instead of a drawer hamburger.
  // Hidden via CSS on desktop, where the sidebar is a visible column.
  onBack?: () => void;
  // A ruling changes the one workspace attention collection owned by
  // V2Layout, so its sidebar, inspector, and phone badge refresh together.
  onDecisionSettled?: () => void;
}

const V2Thread: React.FC<V2ThreadProps> = ({ detail, firstRunVisible = false, inspectorCollapsed, onToggleInspector, onOpenMember, onOpenInvite, onOpenFile, onBack, onDecisionSettled }) => {
  const { t } = useTranslation();
  const {
    pod, members, messages, agents, sendMessage, loading, error, sendError,
    hasMore, loadingOlder, loadOlder,
    initialLoadComplete: detailInitialLoadComplete,
    historySearch: detailHistorySearch,
    searchOlderForMessage: detailSearchOlderForMessage,
    retryHistorySearch: detailRetryHistorySearch,
  } = detail;
  const api = useV2Api();
  const navigate = useNavigate();
  const location = useLocation();
  const headerMeta = useV2PodHeaderMeta(pod?._id);
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
  // Keep the id of the last message sent from this composer. Comparing ids,
  // rather than authors, keeps another tab's message from stealing a reader's
  // viewport. The version state re-runs the scroll effect when the POST wins
  // after its socket copy (and therefore the newest id) already arrived.
  const sentMessageIdRef = useRef<string | null>(null);
  const [sendFollowVersion, setSendFollowVersion] = useState(0);
  const activePodIdRef = useRef<string | null>(pod?._id || null);
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

  // A late response from a pod we left must not make the first message in the
  // next pod look like it came from this composer.
  useLayoutEffect(() => {
    activePodIdRef.current = pod?._id || null;
    sentMessageIdRef.current = null;
    setSendFollowVersion((version) => version + 1);
  }, [pod?._id]);

  // Setting one composer target clears the other. Two chips would be two
  // meanings for one send, and the resolver rejects a message carrying both.
  // Aiming puts the cursor in the field so Esc (un-aim) and typing both land.
  const aimAtThread = useCallback((rootId: string, preview: string) => {
    setReplyTarget(null);
    setThreadTarget({ id: rootId, preview });
    composerInputRef.current?.focus();
  }, []);
  const aimAtMessage = useCallback((m: import('../hooks/useV2PodDetail').V2Message) => {
    setThreadTarget(null);
    setReplyTarget(m);
    composerInputRef.current?.focus();
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
  const flatReplyIdsRef = useRef<{ podId: string | null; ids: Set<string> }>({ podId: null, ids: new Set() });
  const threadView = useMemo(() => {
    const podId = pod?._id || null;
    if (flatReplyIdsRef.current.podId !== podId) {
      flatReplyIdsRef.current = { podId, ids: new Set() };
    }
    // A reply visible flat before its root arrived must stay flat. Otherwise
    // prepending an older page relocates it into a resting thread chip.
    flatReplyIdsRef.current.ids = freezeOrphanReplyIds(messages, flatReplyIdsRef.current.ids);
    return buildThreadView(messages, threadState.byRoot, flatReplyIdsRef.current.ids);
  }, [messages, pod?._id, threadState.byRoot]);

  // #891 surface 1: agent reachability at the moment of composing a mention.
  // Best-effort — a failed read renders nothing rather than something wrong,
  // and 60s refresh keeps the states honest without hammering the endpoint.
  const [agentStates, setAgentStates] = useState<AgentStateRow[]>([]);
  const [decisions, setDecisions] = useState<ThreadDecision[]>([]);
  const [settledDecisionByMessageId, setSettledDecisionByMessageId] = useState<Map<string, V2DecisionRuling>>(new Map());
  const loadedMessageIdsRef = useRef<string[]>([]);
  loadedMessageIdsRef.current = [...new Set(messages
    .map((message) => String(message.id || ''))
    .filter(Boolean))];

  // A DecisionRequest posts an ordinary message for its timeline position and
  // materializes its typed choices in the attention queue. Join those two
  // durable records by messageId; never infer a card from agent prose.
  useEffect(() => {
    const podId = pod?._id;
    if (!podId) {
      setDecisions([]);
      setSettledDecisionByMessageId(new Map());
      return undefined;
    }
    let active = true;
    const load = async () => {
      try {
        const [pendingData, historyData] = await Promise.all([
          loadDecisionPagesForMessageIds<ThreadDecision>(api, '/api/activity/decision-queue', podId, loadedMessageIdsRef.current).catch(() => null),
          loadDecisionPagesForMessageIds<ThreadDecision>(api, '/api/activity/decision-history', podId, loadedMessageIdsRef.current).catch(() => null),
        ]);
        if (!active) return;
        // A failed queue read is not authoritative. Preserve pending cards
        // already rendered in this mount rather than making an open decision
        // disappear during a transient 429/network failure.
        if (pendingData) {
          setDecisions(pendingData.items.filter((item) => (
            item.kind === 'decision'
            && item.podId === podId
            && typeof item.messageId === 'string'
            && item.messageId.length > 0
            && Array.isArray(item.options)
            && item.options.length > 0
          )));
        }
        // A successful empty history page is authoritative and clears rows
        // that are no longer ruled. A failed history read is not authoritative
        // and must preserve settled cards already rendered in this mount.
        if (historyData) {
          const settled = (historyData.items || []).filter((item) => (
            item.kind === 'decision'
            && item.podId === podId
            && typeof item.messageId === 'string'
            && item.ruling?.value
          ));
          setSettledDecisionByMessageId(new Map(
            settled.map((item) => [String(item.messageId), item.ruling as V2DecisionRuling]),
          ));
        }
      } catch {
        // A queue read is additive decoration: preserve a working thread when
        // attention is temporarily unavailable rather than inventing cards.
        // Keep any durable settled map already rendered during this mount.
        if (active) setDecisions([]);
      }
    };
    void load();
    const timer = window.setInterval(load, 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [api, pod?._id, detailInitialLoadComplete]);

  const decisionByMessageId = useMemo(() => new Map(
    decisions.map((decision) => [String(decision.messageId), decision]),
  ), [decisions]);

  useEffect(() => {
    setSettledDecisionByMessageId(new Map());
  }, [pod?._id]);

  const handleDecisionRuled = useCallback((decisionId: string, ruling: V2DecisionRuling) => {
    const source = decisions.find((decision) => decision.id === decisionId);
    if (!source) return;
    setSettledDecisionByMessageId((current) => {
      const next = new Map(current);
      next.set(String(source.messageId), ruling);
      return next;
    });
    onDecisionSettled?.();
  }, [decisions, onDecisionSettled]);

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
  // Direction C history: the reader's position is respected. Background
  // arrivals pull the view down only when it was already at the bottom;
  // otherwise they count up in the Jump-to-latest pill. Explicit local sends
  // follow in the separate confirmation effect below.
  const atBottomRef = useRef(true);
  const [jumpCount, setJumpCount] = useState(0);
  // The pill mounts once the reader is a viewport up; `· N` only with arrivals.
  const [scrolledUp, setScrolledUp] = useState(false);
  const edgeRef = useRef<HTMLDivElement | null>(null);
  const jumpToLatest = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    atBottomRef.current = true;
    setJumpCount(0);
    setScrolledUp(false);
  }, []);
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return undefined;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      const near = distance < 80;
      atBottomRef.current = near;
      setScrolledUp(distance > el.clientHeight);
      if (near) setJumpCount(0);
    };
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [pod?._id]);
  useEffect(() => {
    if (!newestMessageId) return;
    if (atBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      setJumpCount(0);
    } else {
      setJumpCount((count) => count + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newestMessageId]);

  // A successful POST is an explicit local follow instruction, independent
  // of which socket row won the race or whether another row arrived after it.
  // Keeping this separate from arrival counting prevents the confirmation
  // render from incrementing the Jump pill when no new message arrived.
  useEffect(() => {
    if (!sendFollowVersion || !sentMessageIdRef.current) return;
    atBottomRef.current = true;
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    setJumpCount(0);
  }, [sendFollowVersion]);

  const rememberSentMessage = useCallback((sendPodId: string, created: import('../hooks/useV2PodDetail').V2Message) => {
    const id = String(created?.id || (created as { _id?: string })?._id || '');
    if (!id || activePodIdRef.current !== sendPodId) return;
    sentMessageIdRef.current = id;
    // The confirmation version is independent of the socket row's ordering.
    setSendFollowVersion((version) => version + 1);
  }, []);

  // Prepending moves every already-rendered row below the inserted page. Keep
  // one such row as the anchor and measure its content offset, rather than the
  // container's total height: a peer append at the bottom must not be part of
  // the compensation.
  const findAnchorRow = useCallback((container: HTMLElement, preferredId: string | null) => {
    const preferred = preferredId ? document.getElementById(`message-${preferredId}`) : null;
    if (preferred && container.contains(preferred)) return preferred;
    return container.querySelector<HTMLElement>('[id^="message-"]');
  }, []);
  const measureAnchorOffset = useCallback((container: HTMLElement, row: HTMLElement | null) => {
    if (!row || !container.contains(row)) return null;
    const containerRect = container.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    // Rect + scrollTop is the row's position in the scroll content. It stays
    // stable when a reader scrolls while the request is in flight.
    return rowRect.top - containerRect.top + container.scrollTop;
  }, []);
  const scrollAnchorRef = useRef<{
    podId: string | null;
    oldestId: string | null;
    rowId: string;
    rowOffset: number;
  } | null>(null);
  const currentPodId = pod?._id ? String(pod._id) : null;
  const oldestMessageId = messages[0]?.id ? String(messages[0].id) : null;
  const handleLoadOlder = useCallback(async () => {
    // The edge button is replaced by a loading status after the first click,
    // but keep the first request's anchor when two events batch before React
    // commits. The hook's own loading ref suppresses the duplicate fetch.
    const existingAnchor = scrollAnchorRef.current;
    const ownsAnchor = existingAnchor == null;
    const el = messagesContainerRef.current;
    const row = el ? findAnchorRow(el, oldestMessageId) : null;
    const rowOffset = el ? measureAnchorOffset(el, row) : null;
    const anchor = existingAnchor || (el && row && rowOffset !== null
      ? {
        podId: currentPodId,
        oldestId: oldestMessageId,
        rowId: row.id,
        rowOffset,
      }
      : null);
    if (ownsAnchor) {
      scrollAnchorRef.current = anchor;
      if (anchor && el) el.dataset.historyAnchor = 'active';
    }
    const result = await loadOlder();
    if (!ownsAnchor) return;
    if (result !== 'prepended' && result !== 'unchanged') {
      // Empty/error/no-op responses do not produce a prepend. Clear the arm
      // now so an unrelated future append cannot apply a stale compensation.
      if (scrollAnchorRef.current === anchor) {
        scrollAnchorRef.current = null;
        if (el) delete el.dataset.historyAnchor;
      }
    } else if (scrollAnchorRef.current === anchor) {
      // A successful prepend is consumed by the committed-row layout effect;
      // do not clear it here before a deferred React commit can be observed.
      if (result === 'unchanged') {
        scrollAnchorRef.current = null;
        if (el) delete el.dataset.historyAnchor;
      }
    }
  }, [currentPodId, findAnchorRow, loadOlder, measureAnchorOffset, oldestMessageId]);

  // Older detail fixtures (and a few read-only embed callers) predate the
  // bounded source-search fields. Keep those callers on the legacy one-page
  // behavior while the real hook supplies the capped search implementation.
  const idleHistorySearch: HistorySearchState = {
    targetId: null,
    status: 'idle',
    attempt: 0,
    maxAttempts: 5,
    error: null,
  };
  const historySearch = detailHistorySearch || idleHistorySearch;
  // Older fixtures and read-only embeds predate the readiness field; their
  // supplied messages are already settled. The real hook keeps this false
  // through its first pod/message read, even though `loading` starts false.
  const initialLoadComplete = detailInitialLoadComplete ?? true;
  const legacySearchOlder = useCallback(async () => { await handleLoadOlder(); }, [handleLoadOlder]);
  const searchOlderForMessage = detailSearchOlderForMessage || legacySearchOlder;

  useLayoutEffect(() => {
    const el = messagesContainerRef.current;
    const anchor = scrollAnchorRef.current;
    if (!el || anchor == null) return;
    if (anchor.podId !== currentPodId) {
      scrollAnchorRef.current = null;
      delete el.dataset.historyAnchor;
      return;
    }
    const firstId = messages[0]?.id ? String(messages[0].id) : null;
    const row = document.getElementById(anchor.rowId);
    const rowOffset = measureAnchorOffset(el, row);
    if (rowOffset === null) {
      scrollAnchorRef.current = null;
      delete el.dataset.historyAnchor;
      return;
    }
    if (firstId === anchor.oldestId) {
      // A socket append changed the list without prepending anything. Move
      // the baseline forward so the eventual older page is measured against
      // the same rendered row, while leaving the reader's scrollTop alone.
      anchor.rowOffset = rowOffset;
      return;
    }
    // Apply only the movement of the existing row across the commit that
    // changed the oldest id. Reading the current scrollTop preserves any user
    // scrolling that happened while the request was in flight, and a bottom
    // append does not move this row.
    el.scrollTop += rowOffset - anchor.rowOffset;
    scrollAnchorRef.current = null;
    delete el.dataset.historyAnchor;
  }, [currentPodId, measureAnchorOffset, messages]);

  // Pasting an image into the field attaches it. The handler is defined
  // later (it needs the upload plumbing), so the effect reads it through a ref
  // and stays above the early return with the other hooks.
  const attachFileRef = useRef<((file: File | null) => Promise<void>) | null>(null);
  useEffect(() => {
    const el = composerInputRef.current;
    if (!el) return undefined;
    const onPaste = (event: ClipboardEvent) => {
      const file = Array.from(event.clipboardData?.files || []).find((candidate) => candidate.type.startsWith('image/'));
      if (!file) return;
      event.preventDefault();
      void attachFileRef.current?.(file);
    };
    el.addEventListener('paste', onPaste);
    return () => el.removeEventListener('paste', onPaste);
  }, [pod?._id]);

  useEffect(() => {
    if (!loading && pod && messages.length === 0) composerInputRef.current?.focus();
  }, [loading, pod?._id, messages.length]);
  // Landing on a message from Activity / a quote: `#message-<id>` scrolls to the
  // row and marks it landed. If the row is not in the loaded window yet, the
  // previous pages load until it is (the `after` cursor is kernel row k4).
  // Key landing guards by the resolved message id, not the URL spelling. A
  // decision-card producer may use either canonical `#message-<id>` or the
  // legacy `?message=<id>` form; both must share one retry/reveal lifecycle.
  const landedTargetRef = useRef<string | null>(null);
  // Hydrating a settled ruling can replace a focused decision-card DOM node.
  // Remember the exact node so we can restore landing only when that
  // replacement caused the blur; deliberate focus movement must win.
  const landedElementRef = useRef<HTMLElement | null>(null);
  const landedElementShapeRef = useRef<string | null>(null);
  const landedDecisionFingerprintRef = useRef<string | null>(null);
  // A URL target remains in the address bar after landing. Keep automatic
  // prepends paused until the reader deliberately uses the edge control, so
  // the focused row cannot be pushed out while a landing is settling.
  const releasedLandingTargetRef = useRef<string | null>(null);
  const releasedHistorySearchTargetRef = useRef<string | null>(null);
  // A target that is loaded but not rendered (collapsed thread, `N more
  // replies` fold) is REVEALED, not fetched: the transcript opens the thread
  // and bumps `revealTick` so this effect runs again against the new DOM.
  const [revealRequest, setRevealRequest] = useState<string | null>(null);
  const [revealTick, setRevealTick] = useState(0);
  const revealTriedRef = useRef<string | null>(null);
  const onQuoteNavigate = useCallback((_messageId: string | number) => {
    // A repeated quote can have the same hash after the user collapsed the
    // thread. Clear the landing guards and bump the effect so this gesture
    // reopens the fold instead of being treated as an already-landed hash.
    landedTargetRef.current = null;
    landedElementRef.current = null;
    landedElementShapeRef.current = null;
    landedDecisionFingerprintRef.current = null;
    revealTriedRef.current = null;
    releasedLandingTargetRef.current = null;
    releasedHistorySearchTargetRef.current = null;
    setRevealTick((tick) => tick + 1);
  }, []);
  const onRevealed = useCallback((messageId: string, found: boolean) => {
    setRevealRequest(null);
    if (found) setRevealTick((tick) => tick + 1);
    else revealTriedRef.current = `miss:${messageId}`;
  }, []);
  const landingTarget = React.useMemo(() => {
    const hashMatch = (location.hash || '').match(/^#message-(.+)$/);
    // The canonical hash is authoritative when both forms are present.
    if (hashMatch) return hashMatch[1];
    return new URLSearchParams(location.search || '').get('message');
  }, [location.hash, location.search]);
  const retryHistorySearch = useCallback(async () => {
    // Retry is a new automatic target search, so a previous deliberate edge
    // release must not let the sentinel bypass the fresh bounded search.
    releasedLandingTargetRef.current = null;
    releasedHistorySearchTargetRef.current = null;
    await (detailRetryHistorySearch || legacySearchOlder)();
  }, [detailRetryHistorySearch, legacySearchOlder]);
  const handleExplicitLoadOlder = useCallback(async () => {
    // The edge button is deliberate. It is the reader's explicit signal that
    // ordinary browsing should resume after a targeted landing/search.
    if (landingTarget) releasedLandingTargetRef.current = landingTarget;
    if (historySearch.targetId) releasedHistorySearchTargetRef.current = historySearch.targetId;
    await handleLoadOlder();
  }, [landingTarget, historySearch.targetId, handleLoadOlder]);
  useEffect(() => {
    const target = landingTarget;
    if (!target) {
      landedTargetRef.current = null;
      landedElementRef.current = null;
      landedElementShapeRef.current = null;
      landedDecisionFingerprintRef.current = null;
      releasedLandingTargetRef.current = null;
      return;
    }
    if (releasedLandingTargetRef.current && releasedLandingTargetRef.current !== target) {
      releasedLandingTargetRef.current = null;
    }
    if (!initialLoadComplete) return;
    const settledRuling = settledDecisionByMessageId.get(target);
    const durableLoaded = !!settledRuling?.messageId
      && messages.some((message) => String(message.id) === String(settledRuling.messageId));
    const decisionFingerprint = settledRuling
      ? `${target}:${settledRuling.messageId || ''}:${settledRuling.value}:${settledRuling.at || ''}:${durableLoaded ? 'loaded' : 'fallback'}`
      : 'none';
    if (landedTargetRef.current === target) {
      const activeElement = typeof document !== 'undefined' ? document.activeElement : null;
      const landingNodeReplaced = activeElement === document.body
        && !!landedElementRef.current
        && !document.body.contains(landedElementRef.current);
      const currentShape = landedElementRef.current?.className
        .replace(/\bv2-msg--landed\b/g, '')
        .trim();
      const landingShapeChanged = !!landedElementShapeRef.current
        && currentShape !== landedElementShapeRef.current;
      if (landedDecisionFingerprintRef.current === decisionFingerprint
        && !landingNodeReplaced && !landingShapeChanged) return;
      const focusedElsewhere = !!activeElement
        && activeElement !== document.body
        && activeElement !== landedElementRef.current;
      if (focusedElsewhere || (!landingNodeReplaced && !landingShapeChanged)) {
        // The reader moved focus (or the node stayed mounted); do not steal it
        // merely because a polling map got a new object identity.
        landedDecisionFingerprintRef.current = decisionFingerprint;
        landedElementShapeRef.current = currentShape || null;
        return;
      }
      landedTargetRef.current = null;
      landedElementRef.current = null;
      landedElementShapeRef.current = null;
    }
    if (landOnMessage(target)) {
      landedTargetRef.current = target;
      landedDecisionFingerprintRef.current = decisionFingerprint;
      landedElementRef.current = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      landedElementShapeRef.current = landedElementRef.current?.className
        .replace(/\bv2-msg--landed\b/g, '')
        .trim() || null;
      return;
    }
    const folded = threadView.some((item) => item.kind === 'card'
      && (item.rootId === target || item.replies.some((reply) => String(reply.id) === target)));
    if (folded && revealTriedRef.current !== target) {
      revealTriedRef.current = target;
      setRevealRequest(target);
      return;
    }
    // The hook owns the bounded search state. Once a target has failed or the
    // five-page bound has been reached, this effect must stay quiet until the
    // reader explicitly presses Retry.
    if (!loadingOlder && !loading
      && !(historySearch.targetId === target
        && (historySearch.status === 'searching'
          || historySearch.status === 'failed'
          || historySearch.status === 'not-found'))) {
      void searchOlderForMessage(target);
    }
  }, [landingTarget, initialLoadComplete, messages, threadView, decisionByMessageId, settledDecisionByMessageId, revealTick, loadingOlder, loading, historySearch.targetId, historySearch.status, searchOlderForMessage]);

  // Reaching the top loads the previous page; the edge line is the sentinel.
  useEffect(() => {
    const edge = edgeRef.current;
    const root = messagesContainerRef.current;
    if (!edge || !root || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      if (!hasMore || loadingOlder || loading) return;
      // The sentinel is automatic. During a target landing (including a
      // stopped search) it must not prepend a page behind the focused row or
      // silently bypass the bound. The edge button remains deliberate and
      // continues to call handleLoadOlder normally.
      const landingBlocked = landingTarget
        && (landedTargetRef.current !== landingTarget
          || releasedLandingTargetRef.current !== landingTarget);
      const searchBlocked = historySearch.targetId
        && historySearch.status !== 'idle'
        && releasedHistorySearchTargetRef.current !== historySearch.targetId;
      if (landingBlocked || searchBlocked) return;
      void handleLoadOlder();
    }, { root, rootMargin: '120px 0px 0px 0px' });
    observer.observe(edge);
    return () => observer.disconnect();
  }, [hasMore, loadingOlder, loading, landingTarget, historySearch.targetId, historySearch.status, handleLoadOlder, pod?._id]);

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

  // Runtime short name per agent author key (direction C, walk-3 miss 51):
  // the mono tag after the time. Unknown runtime = no tag.
  const agentTags = React.useMemo(() => {
    const shortName = (runtimeType?: string): string | null => {
      switch ((runtimeType || '').toLowerCase()) {
        case 'codex': return 'codex';
        case 'claude-code': return 'claude';
        case 'openclaw': case 'moltbot': return 'openclaw';
        case 'internal': return 'hosted';
        case 'webhook': return 'webhook';
        default: return null;
      }
    };
    const map = new Map<string, string>();
    (agents || []).forEach((agent) => {
      const tag = shortName(agent.runtime?.runtimeType || agent.runtime?.wrappedCli);
      if (!tag) return;
      const label = agent.profile?.displayName || agent.displayName || agent.agentName;
      const username = buildAgentUsername(agent.agentName, agent.instanceId || 'default');
      [label, username, agent.agentName].filter(Boolean).forEach((key) => map.set(String(key).toLowerCase(), tag));
    });
    return map;
  }, [agents]);

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

  // Phone-only back control: returns to the pods list page. CSS hides it on
  // desktop (>=761px) where the sidebar is a permanent column.
  const mobileNavButton = onBack ? (
    <button
      type="button"
      className="v2-thread__back"
      onClick={onBack}
      title={t('podChat.header.backToPods')}
      aria-label={t('podChat.header.backToPods')}
    >
      <ArrowBackIcon fontSize="small" aria-hidden="true" />
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
    const sendPodId = pod?._id;
    if (!sendPodId) return;
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
        rememberSentMessage(sendPodId, created);
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
  // Paste an image straight into the thread: from the plus menu (clipboard
  // read) or by pasting into the field.
  const attachFromClipboard = async () => {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((candidate) => candidate.startsWith('image/'));
        if (type) {
          const blob = await item.getType(type);
          const ext = type.split('/')[1] || 'png';
          await handleAttachFile(new File([blob], `pasted-${Date.now()}.${ext}`, { type }));
          return;
        }
      }
      setComposerError(t('podChat.composer.clipboardEmpty'));
    } catch {
      fileInputRef.current?.click();
    }
  };
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
        // One attachment model (direction C): the image goes out as the same
        // `[[upload:…|image]]` manifest a file does, so the row renders a
        // thumbnail and an agent reads it through the attachment tool. The
        // bare URL remains only for a server that returned no file key.
        const imageContent = uploaded.fileName
          ? `[[upload:${uploaded.fileName}|${uploaded.originalName || file.name}|${uploaded.size || file.size}|image]]`
          : uploaded.url;
        const created = await sendMessage(
          imageContent,
          'image',
          replyTarget?.id || undefined,
          threadTarget?.id || undefined,
        );
        if (created) {
          rememberSentMessage(pod._id, created);
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
  attachFileRef.current = handleAttachFile;

  const starterPrompts = STARTER_PROMPT_KEYS.map((key) => t(key));
  // Header meta (direction C): members · agents · board N open · bound
  // channels. The agents-working count left the header for the inspector.
  const humanMemberCount = (members || []).filter((member) => !member?.isBot).length;
  const metaParts: React.ReactNode[] = [
    <span key="members">{t('podChat.header.members', { count: humanMemberCount })}</span>,
    <span key="agents">{t('podChat.header.agents', { count: agents.length })}</span>,
  ];
  if (headerMeta.boardOpen !== null) {
    metaParts.push(
      <button key="board" type="button" className="v2-pod-header__board" onClick={() => navigate(`/v2/pods/${pod._id}/board`)}>
        {t('podChat.header.boardOpen', { count: headerMeta.boardOpen })}
      </button>,
    );
  }
  headerMeta.channels.forEach((channel) => {
    metaParts.push(<span key={`channel-${channel}`} className="v2-pod-header__channel">{channel}</span>);
  });

  return (
    <main className="v2-pane v2-pane--main">
      <div className="v2-chat v2-thread">
        <header className="v2-thread__header v2-pod-header">
          <div className="v2-thread__header-row">
            {mobileNavButton}
            <div className="v2-thread__title">
              <div className="v2-thread__title-line">
                <h1>{pod.name}</h1>
                {pod.description && <p>{pod.description}</p>}
              </div>
            </div>
            <span className="v2-pod-header__meta v2-pod-header__meta--compact" aria-hidden="true">
              {t('podChat.header.compactMeta', { members: humanMemberCount, count: agents.length })}
            </span>
            <span className="v2-pod-header__meta">
              {metaParts.map((part, index) => (
                <React.Fragment key={index}>
                  {index > 0 && <span className="v2-pod-header__sep" aria-hidden="true">·</span>}
                  {part}
                </React.Fragment>
              ))}
            </span>
            {onToggleInspector && (
              <button
                type="button"
                className={`v2-thread__inspector-toggle${inspectorCollapsed ? '' : ' v2-thread__inspector-toggle--active'}`}
                onClick={onToggleInspector}
                title={inspectorCollapsed ? t('podChat.team.view') : t('podChat.team.hide')}
                aria-label={inspectorCollapsed ? t('podChat.team.view') : t('podChat.team.hide')}
                aria-pressed={!inspectorCollapsed}
              >
                <ViewSidebarOutlinedIcon fontSize="small" aria-hidden="true" />
              </button>
            )}
          </div>
        </header>

        <V2CatchUpStrip podId={pod._id} />

        <div className="v2-thread__transcript">
          <V2ThreadMessages
            messages={messages}
            threadView={threadView}
            threadState={threadState}
            revealMessageId={revealRequest}
            onRevealed={onRevealed}
            decisionByMessageId={decisionByMessageId}
            settledDecisionByMessageId={settledDecisionByMessageId}
            agentDisplayNames={agentDisplayNames}
            agentTags={agentTags}
            agentAuthorKeys={agentAuthorKeys}
            onAuthorClick={onOpenMember ? handleAuthorClick : undefined}
            onOpenFile={onOpenFile}
            onReply={isReadOnly ? undefined : aimAtMessage}
            onThread={isReadOnly ? undefined : aimAtMessageThread}
            onQuoteNavigate={onQuoteNavigate}
            onDecisionRuled={handleDecisionRuled}
            onAimAtThread={aimAtThread}
            hasMore={hasMore}
            loadingOlder={loadingOlder}
            onLoadOlder={() => { void handleExplicitLoadOlder(); }}
            edgeRef={edgeRef}
            jumpCount={jumpCount}
            showJump={scrolledUp}
            onJump={jumpToLatest}
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
                    // Direction C: an empty pod is one mono line and a focused composer.
                    <span className="v2-thread__empty-line">{t('podChat.empty.noMessages')}</span>
                  )}
                </div>
            ) : undefined}
            agentDeliveryHint={agentDeliveryHint}
            messagesContainerRef={messagesContainerRef}
            messagesEndRef={messagesEndRef}
          />
          <V2ThreadHistoryStatus
            historySearch={historySearch}
            onRetryHistorySearch={() => { void retryHistorySearch(); }}
            viewport
          />
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
                  // Esc with no mention menu open un-aims the composer (the aim
                  // chip's keyboard cancel); the draft itself is kept.
                  if (event.key === 'Escape' && (replyTarget || threadTarget)) {
                    event.preventDefault();
                    setReplyTarget(null);
                    setThreadTarget(null);
                    return;
                  }
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void handleSend();
                  }
                  if (event.key === 'Escape' && (replyTarget || threadTarget)) {
                    event.preventDefault();
                    setReplyTarget(null);
                    setThreadTarget(null);
                  }
                }}
                onMentionSelect={selectMention}
                onSend={() => { void handleSend(); }}
                onAttach={(file) => { void handleAttachFile(file); }}
                onPasteFromClipboard={() => { void attachFromClipboard(); }}
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
