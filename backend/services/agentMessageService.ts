// eslint-disable-next-line global-require
const socketConfig = require('../config/socket');
// eslint-disable-next-line global-require
const agentTypingService = require('./agentTypingService');
// eslint-disable-next-line global-require
const Message = require('../models/Message');
// eslint-disable-next-line global-require
const Summary = require('../models/Summary');
// eslint-disable-next-line global-require
const AgentIdentityService = require('./agentIdentityService');
// eslint-disable-next-line global-require
const PodAssetService = require('./podAssetService');
// eslint-disable-next-line global-require
const AgentEventService = require('./agentEventService');
// eslint-disable-next-line global-require
const DMService = require('./dmService');
// eslint-disable-next-line global-require
const { AgentInstallation } = require('../models/AgentRegistry');
// eslint-disable-next-line global-require
const User = require('../models/User');
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');

const File = require('../models/File');

const mongoose = require('mongoose');

// Upper bound on how many File rows we fetch per phantom-directive
// scan. The single-query refactor (see postMessage phantom-directive
// block) trades a per-directive lookup for one batched fetch + an
// in-memory Set comparison. The bound prevents a pathologically large
// pod from blowing up the message pipeline. Typical pod has 10-100
// files; even Nova's YC pitch pod after a heavy artifact day was ~30.
// Tunable here without touching the hot path. Override at deploy via
// env if a real workload ever justifies it.
const FILE_DIRECTIVE_SCAN_LIMIT = (() => {
  const raw = process.env.COMMONLY_FILE_DIRECTIVE_SCAN_LIMIT;
  if (!raw) return 500;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 500;
})();

// How recently THIS agent must have uploaded a file to this pod for a
// "Done — attached the deck" narration (which carries no `[[upload:]]`
// directive of its own) to be treated as a legitimate post-attach follow-up
// rather than a false-attach claim. The tool posts the directive message and
// the narration within the same turn, so a few minutes is ample.
const RECENT_ATTACH_WINDOW_MS = 5 * 60 * 1000;

// Prefix length scanned for a false-attach claim. Bounds the polynomial
// backtracking in the claim pattern (js/polynomial-redos) on agent-authored,
// therefore attacker-influenced, content. Generous next to the sentence-shaped
// pattern it feeds, which matches at the start of a statement.
const ATTACH_CLAIM_SCAN_LIMIT = 2000;

// Runtime artifacts are exact values, not a language heuristic. Short,
// all-caps agent replies regularly carry valid protocol or markup identifiers;
// add an entry here only after observing it as a wrapper artifact in production.
const BARE_RUNTIME_ARTIFACTS = new Set(['RGCTX']);

let PGMessage: unknown = null;
try {
  // eslint-disable-next-line global-require
  PGMessage = require('../models/pg/Message');
} catch (error) {
  PGMessage = null;
}

interface AgentUserDoc {
  _id: unknown;
  username?: string;
  profilePicture?: string;
  isBot?: boolean;
  botMetadata?: { displayName?: string };
}

interface MetadataDoc {
  sourceEventType?: string;
  eventType?: string;
  sourceEventId?: string;
  eventId?: string;
  mentionTargets?: string[];
  heartbeatFallbackReason?: string;
  heartbeatFallbackPosted?: boolean;
  summaryType?: string;
  title?: string;
  summary?: {
    title?: string;
    content?: string;
    timeRange?: { start?: string; end?: string };
    messageCount?: number;
    totalItems?: number;
  };
  summaryContent?: string;
  timeRange?: { start?: string; end?: string };
  messageCount?: number;
  totalItems?: number;
  source?: string;
  podName?: string;
  [key: string]: unknown;
}

interface PostMessageOptions {
  agentName: string;
  podId: unknown;
  content: string;
  metadata?: MetadataDoc;
  messageType?: string;
  // ADR-020 D3: structured component payload (approval cards). Bypasses
  // sanitizeAgentContent by design — content stays the sanitized fallback
  // text; payload is server-composed, never model prose.
  payload?: unknown;
  instanceId?: string;
  displayName?: string;
  replyToMessageId?: string | null;
  // Explicit thread membership without addressing (constraint 5). Resolved
  // and validated by threadRootResolver before the INSERT, same as the
  // human composer path.
  threadRootId?: string | null;
  installationConfig?: unknown;
}

interface PostTargetOptions {
  agentName: string;
  instanceId?: string;
  podId: unknown;
  content: string;
  messageType?: string;
  metadata?: MetadataDoc;
  payload?: unknown;
  agentUser: AgentUserDoc;
  displayName?: string;
  replyToMessageId?: string | null;
  threadRootId?: string | null;
  skipDeliveryUpdate?: boolean;
  skipSummaryPersistence?: boolean;
}

interface HeartbeatFallbackOptions {
  agentName: string;
  instanceId: string;
  podId: unknown;
  messageType: string;
  metadata: MetadataDoc;
  agentUser: AgentUserDoc;
  displayName?: string;
  sourceContent: string;
}

interface RouteErrorOptions {
  agentName: string;
  instanceId?: string;
  podId: unknown;
  content: string;
  agentUser: AgentUserDoc;
  displayName?: string;
  messageType?: string;
  metadata?: MetadataDoc;
  postSourceNotice?: boolean;
}

interface MessageNormalized {
  _id: unknown;
  id: unknown;
  content: string;
  messageType: string;
  userId: { _id: unknown; username: string; profilePicture?: string };
  username: string;
  isBot?: boolean;
  // Present ONLY when the caller identified itself via `selfUserId`. An
  // explicit boolean (never undefined) so a client can tell "this server
  // computes self" apart from "this server is too old to know" — see
  // getRecentMessages.
  self?: boolean;
  createdAt: Date | string;
  metadata?: MetadataDoc;
  payload?: unknown;
  profile_picture?: string;
  replyTo?: { id: string; content: string; username: string; userId: string } | null;
  // Threading (#1106): the PG INSERT derives this on write (RETURNING *), so
  // it is present on every PG-created row. Snake case because the frontend's
  // threadView reads `m.thread_root_id` verbatim off both fetch and socket.
  thread_root_id?: number | string | null;
  // The addressing edge, distinct from thread membership by design (the
  // two-column ruling in docs/design/threading-surface-ruling.md).
  reply_to_message_id?: number | string | null;
}

interface StructuredSummary {
  summaryType: string | null;
  title: string | null;
  body: string | null;
  timeRange: { start?: string; end?: string } | null;
  messageCount: number;
  source: string | null;
  eventId: string | null;
}

interface RecentActivitySignal {
  snippet: string;
  author: string | null;
}

interface DuplicateResult {
  id: unknown;
  createdAt: unknown;
  dedupeWindowMinutes: number;
}

class AgentMessageService {
  static normalizeInstallationConfig(config: unknown): Record<string, unknown> {
    if (!config) return {};
    if (config instanceof Map) {
      return Object.fromEntries((config as Map<string, unknown>).entries());
    }
    if (typeof config === 'object') {
      return config as Record<string, unknown>;
    }
    return {};
  }

  static shouldRouteErrorsToOwnerDM(installationConfig: unknown): boolean {
    const normalizedConfig = AgentMessageService.normalizeInstallationConfig(installationConfig);
    const errorRouting = normalizedConfig?.errorRouting;
    if (!errorRouting || typeof errorRouting !== 'object') return false;
    return (errorRouting as Record<string, unknown>).ownerDm === true;
  }

  static shouldRequireHeartbeatMention(installationConfig: unknown): boolean {
    const normalizedConfig = AgentMessageService.normalizeInstallationConfig(installationConfig);
    if (normalizedConfig?.heartbeatRequireMention === true) return true;
    return false;
  }

  static isErrorContent(content: unknown): boolean {
    const text = String(content || '');
    if (!text.trim()) return false;

    const patterns = [
      /\berror\b.*\b(reading|fetching|loading|accessing)\b/i,
      /\bcannot\b.*\b(read|access|fetch|load|connect)\b/i,
      /\bfailed to\b.*\b(read|fetch|load|access|connect|generate)\b/i,
      /\bmessage:\s*send\b.*\bfailed\b/i,
      /\bunknown target\b/i,
      /\bcontext (overflow|window|length|limit)\b/i,
      /\btoo many tokens\b/i,
      /\bprompt too (large|long)\b/i,
      /\brate limit(?:ing|ed)?\b/i,
      /\bdue to rate\b/i,
      /\bi have no tools available\b/i,
      /\bno tools available\b.*\bcannot fulfill\b/i,
      /\b(401|403|404|429|500|502|503)\b.*\b(error|status|response)\b/i,
      /\bAPI (key|token)\b.*\b(invalid|expired|missing)\b/i,
      /\bauthentication\b.*\b(failed|error|invalid)\b/i,
      /\bcommonly pod service is (?:not running|still not running)\b/i,
      /\bunable to (?:get|read|fetch) (?:the )?pod activity\b/i,
      /\brequired commonly tools are not available\b/i,
      /\bcannot perform (?:the )?required pod activity check\b/i,
      /\bmissing(?: [a-z]+)? tokens?\b/i,
      /\bstack trace\b/i,
      /\bERROR[:]/i,
      /\bTraceback\b/i,
      /\bException\b/i,
      /\ban unknown error occurred\b/i,
      /\bcommand not found\b/i,
      /\bno such file or directory\b/i,
    ];
    return patterns.some((pattern) => pattern.test(text));
  }

  static isHeartbeatEvent(metadata: MetadataDoc = {}): boolean {
    const sourceEventType = String(
      metadata?.sourceEventType || metadata?.eventType || '',
    ).trim().toLowerCase();
    return sourceEventType === 'heartbeat';
  }

  static isHeartbeatHousekeepingContent(content: unknown): boolean {
    const text = String(content || '').trim();
    if (!text) return false;
    if (/^(HEARTBEAT_OK|HEARTBEAT_NOOP)$/i.test(text)) return true;
    if (/^no reply requested\.?$/i.test(text)) return true;

    const patterns = [
      /\bno meaningful new signals detected\b/i,
      /\bno meaningful new signal to report\b/i,
      /\bheartbeat check complete with no new activity to report\b/i,
      /\bno new activity to report\b/i,
      /\bi(?:'|')ll check the pod activity\b/i,
      /\bi(?:'|')ll check the current pod activity\b/i,
      /\bi(?:'|')ll check the current activity\b/i,
      /\bi need to check the actual pod activity\b/i,
      /\breport back only if there(?:'|')s meaningful new signal\b/i,
      /\bi(?:'|')ve triggered the heartbeat check\b/i,
      /\blet me try (?:fetching|checking)\b/i,
      /\blet me (?:use|try) (?:the )?(?:proper )?runtime api\b/i,
      /\blet me try (?:a )?(?:more )?direct approach\b/i,
      /\blet me try (?:a )?different approach\b/i,
      /\blet me try (?:the )?direct http endpoint approach\b/i,
      /\blet me try (?:a )?simpler approach\b/i,
      /\bchecking pod\b.*\bactivity\b.*\bheartbeat\b/i,
      /\bfetching recent activity from the pod\b/i,
      /\blooking at the last\b.*\bmessages?\b.*\brecent posts?\b/i,
      /\bfound some recent activity\b/i,
      /\brecent chat messages:\b/i,
      /\brecent posts:\b/i,
      /\bheartbeat check complete\b.*\bactive and engaged\b/i,
      /\blocalhost:3000\/api\/agents\/runtime\/pods\b/i,
      /\bmessages_failed\b/i,
      /\bcould you please specify which tool\b/i,
      /\bpayload\.activityHint\b.*\bcurrent pod activity\b.*\bHEARTBEAT_OK\b/i,
      /\bi(?:'|')ll check if there(?:'|')s been recent activity before deciding whether to post\b/i,
      /\bno activity detected\b.*\breturn(?:ing)?\s+HEARTBEAT_OK\b/i,
      /\bbased on the activity hint\b.*\bhasRecentActivity=false\b.*\bHEARTBEAT_OK\b/i,
      /\bdefault heartbeat acknowledgment\b/i,
      /\ball (?:the |my )?searches? returned (?:empty|no) results?\b/i,
      /\bsearches? (?:all )?returned (?:empty|no) results?\b/i,
      /\bI will reply with\b/i,
      /\bI will return\b/i,
      /\bsince all (?:the |my )?searches?\b/i,
    ];
    return patterns.some((pattern) => pattern.test(text));
  }

  static shouldPostHeartbeatFallback(): boolean {
    const raw = String(process.env.AGENT_HEARTBEAT_HOUSEKEEPING_FALLBACK || '').trim().toLowerCase();
    if (!raw) return true;
    if (['0', 'false', 'off', 'no'].includes(raw)) return false;
    return true;
  }

  static normalizeMentionHandle(value: unknown): string {
    return String(value || '')
      .trim()
      .replace(/^@+/, '')
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 40);
  }

  static extractMentionHandles(content: unknown): string[] {
    const text = String(content || '');
    const matches = text.match(/@([a-z0-9][a-z0-9-]{0,39})/gi) || [];
    return Array.from(
      new Set(
        matches
          .map((entry) => AgentMessageService.normalizeMentionHandle(entry))
          .filter(Boolean),
      ),
    );
  }

  static async resolveHeartbeatMentionHandles(options: {
    podId: unknown;
    instanceId: string;
    content: unknown;
    metadata?: MetadataDoc;
  }): Promise<string[]> {
    const { podId, instanceId, content, metadata = {} } = options;
    const explicit = Array.isArray(metadata?.mentionTargets) ? metadata.mentionTargets : [];
    const mentions = new Set<string>();
    explicit.forEach((entry) => {
      const handle = AgentMessageService.normalizeMentionHandle(entry);
      if (handle) mentions.add(handle);
    });
    AgentMessageService.extractMentionHandles(content).forEach((handle) => mentions.add(handle));

    if (mentions.size > 0) return Array.from(mentions).slice(0, 3);

    try {
      const activeInstalls: Array<{ instanceId?: string }> = await AgentInstallation.find({
        podId,
        status: 'active',
      }).select('instanceId').lean();
      const selfHandle = AgentMessageService.normalizeMentionHandle(instanceId);
      activeInstalls
        .map((installation) => AgentMessageService.normalizeMentionHandle(installation?.instanceId))
        .filter(Boolean)
        .filter((handle) => !selfHandle || handle !== selfHandle)
        .sort((a: string, b: string) => a.localeCompare(b))
        .slice(0, 3)
        .forEach((handle: string) => mentions.add(handle));
    } catch (error) {
      const err = error as { message?: string };
      console.warn('Failed to resolve heartbeat mention targets:', err.message);
    }

    if (mentions.size > 0) return Array.from(mentions).slice(0, 3);
    const self = AgentMessageService.normalizeMentionHandle(instanceId) || 'team';
    return [self];
  }

  static buildHeartbeatFallbackContent(options: {
    mentionHandles?: string[];
    sourceEventId?: string;
    recentActivitySignal?: RecentActivitySignal | null;
  }): string {
    const { mentionHandles = [], sourceEventId, recentActivitySignal = null } = options;
    const mentions = mentionHandles.length
      ? mentionHandles.map((handle) => `@${handle}`).join(' ')
      : '@team';
    const suffix = sourceEventId ? ` (${String(sourceEventId).slice(-6)})` : '';
    if (recentActivitySignal?.snippet) {
      const author = recentActivitySignal.author ? ` from @${recentActivitySignal.author}` : '';
      return `${mentions} heartbeat update: latest pod activity${author}: "${recentActivitySignal.snippet}". I will follow up if there is a new actionable change${suffix}.`;
    }
    return `${mentions} heartbeat check-in: no new meaningful pod activity in the latest scan, still monitoring pod and integration activity${suffix}.`;
  }

  static normalizeHeartbeatCoreText(content: unknown): string {
    return String(content || '')
      .toLowerCase()
      .replace(/@([a-z0-9][a-z0-9-]{0,39})/gi, ' ')
      .replace(/[^a-z0-9\s+]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  static isLowValueHeartbeatContent(content: unknown): boolean {
    const raw = String(content || '').trim();
    if (!raw) return true;
    const core = AgentMessageService.normalizeHeartbeatCoreText(raw);
    if (!core) return true;

    const veryShortAckSet = new Set([
      'ok', 'okay', 'k', 'kk', 'noted', 'done', 'yes', 'yep', 'sure',
      'copy', 'roger', 'thanks', 'thx', '+1', 'all good', 'looks good',
      'will do', 'sounds good', 'on it',
    ]);
    if (veryShortAckSet.has(core)) return true;

    const tokens = core.split(' ').filter(Boolean);
    if (tokens.length <= 2 && tokens.every((token) => token.length <= 6)) {
      return true;
    }

    return false;
  }

  static summarizeHeartbeatSnippet(content: unknown): string {
    const text = String(content || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    const max = 140;
    if (text.length <= max) return text;
    return `${text.slice(0, max - 1).trim()}...`;
  }

  static isNonActionableHeartbeatSignalContent(content: unknown): boolean {
    const text = String(content || '').trim();
    if (!text) return true;
    if (text.startsWith('[BOT_MESSAGE]')) return true;

    const patterns = [
      /\bheartbeat update:\s*latest pod activity\b/i,
      /\bheartbeat check(?:-in| complete)?\b/i,
      /\bchecking pod\b.*\bactivity\b/i,
      /\bfetching recent activity\b/i,
      /\blooking at the last\b.*\bmessages?\b/i,
      /\bno (?:new|significant|meaningful) (?:pod )?activity\b/i,
      /\bwill check back in next cycle\b/i,
      /\blooks like there(?:'|')s been good activity in the pod\b/i,
      /\bteam is actively discussing projects\b/i,
      /\brecent chat messages:\b/i,
      /\brecent posts:\b/i,
      /\[timestamp\]/i,
    ];
    return patterns.some((pattern) => pattern.test(text));
  }

  static extractUrls(content: unknown): string[] {
    const text = String(content || '');
    const matches = text.match(/https?:\/\/[^\s\])"'>]+/gi) || [];
    return matches.map((url) => {
      try { return new URL(url).hostname + new URL(url).pathname.replace(/\/$/, ''); } catch { return url; }
    });
  }

  /**
   * "Has this author already shared these exact links recently?" — used to stop
   * a heartbeat agent re-posting the same digest every tick.
   *
   * `authorUserId` scopes the lookback to that author's own messages. Without
   * it the check matched ANY author, so a human dropping a link into the pod
   * suppressed the agent's next post — the agent was silenced for someone
   * else's message (same class of bug as #757).
   */
  static async hasRecentDuplicateUrls(options: {
    podId: unknown;
    content: unknown;
    lookback?: number;
    authorUserId?: unknown;
  }): Promise<boolean> {
    const {
      podId, content, lookback = 10, authorUserId,
    } = options;
    const urls = AgentMessageService.extractUrls(content);
    if (urls.length === 0) return false;
    try {
      const recent = await AgentMessageService.getRecentMessages(podId, lookback);
      if (!Array.isArray(recent) || recent.length === 0) return false;
      const authorId = authorUserId ? String(authorUserId) : null;
      const mine = authorId
        ? recent.filter((m) => String(m?.userId?._id ?? '') === authorId)
        : recent;
      if (mine.length === 0) return false;
      const recentText = mine.map((m) => String(m?.content || '')).join('\n');
      const recentUrls = new Set(AgentMessageService.extractUrls(recentText));
      return urls.every((url) => recentUrls.has(url));
    } catch {
      return false;
    }
  }

  static async findRecentActivityHeartbeatSignal(options: {
    podId: unknown;
    excludeUserId: unknown;
  }): Promise<RecentActivitySignal | null> {
    const { podId, excludeUserId } = options;
    const recent = await AgentMessageService.getRecentMessages(podId, 50);
    if (!Array.isArray(recent) || recent.length === 0) return null;

    const userIds = Array.from(
      new Set(
        recent
          .map((entry) => String((entry as MessageNormalized)?.userId?._id || (entry as { user_id?: string })?.user_id || '').trim())
          .filter(Boolean),
      ),
    );
    const botUserIds = new Set<string>();
    if (userIds.length > 0) {
      try {
        const users: Array<{ _id: unknown; isBot?: boolean }> = await User.find({ _id: { $in: userIds } }).select('_id isBot').lean();
        users
          .filter((user) => user?.isBot === true)
          .forEach((user) => botUserIds.add(String(user._id)));
      } catch (error) {
        const err = error as { message?: string };
        console.warn('Failed to load users for heartbeat signal enrichment:', err.message);
      }
    }

    const blockedActorHandles = new Set([
      'commonlysummarizer', 'commonlybot', 'commonly-bot', 'commonly-summarizer',
    ]);
    const exclude = String(excludeUserId || '').trim();
    type MessageEntry = MessageNormalized & { user_id?: string; username?: string };
    const candidate = (recent as MessageEntry[])
      .slice()
      .reverse()
      .find((entry) => {
        const messageType = String((entry as { messageType?: string })?.messageType || '').toLowerCase();
        if (messageType === 'system') return false;
        const content = String(entry?.content || '').trim();
        if (!content) return false;
        const messageUserId = String(entry?.userId?._id || entry?.user_id || '').trim();
        if (exclude && messageUserId && messageUserId === exclude) return false;
        if (messageUserId && botUserIds.has(messageUserId)) {
          if (exclude && messageUserId === exclude) return false;
        }
        const username = String(entry?.userId?.username || entry?.username || '').trim();
        const actorHandle = AgentMessageService.normalizeMentionHandle(username);
        if (actorHandle && blockedActorHandles.has(actorHandle)) return false;
        if (AgentMessageService.isLowValueHeartbeatContent(content)) return false;
        if (AgentMessageService.isNonActionableHeartbeatSignalContent(content)) return false;
        return true;
      });

    if (!candidate) return null;
    return {
      snippet: AgentMessageService.summarizeHeartbeatSnippet(candidate.content),
      author: AgentMessageService.normalizeMentionHandle(
        (candidate as MessageEntry)?.userId?.username || (candidate as MessageEntry)?.username || '',
      ) || null,
    };
  }

  static async postHeartbeatFallback(options: HeartbeatFallbackOptions): Promise<Record<string, unknown>> {
    const {
      agentName, instanceId, podId, messageType, metadata, agentUser, displayName, sourceContent,
    } = options;
    const mentionHandles = await AgentMessageService.resolveHeartbeatMentionHandles({
      podId,
      instanceId,
      content: sourceContent,
      metadata,
    });
    const recentActivitySignal = await AgentMessageService.findRecentActivityHeartbeatSignal({
      podId,
      excludeUserId: agentUser?._id,
    });
    const fallbackContent = AgentMessageService.buildHeartbeatFallbackContent({
      mentionHandles,
      sourceEventId: String(metadata?.sourceEventId || metadata?.eventId || ''),
      recentActivitySignal,
    });
    const posted = await AgentMessageService._postToTarget({
      agentName,
      instanceId,
      podId,
      content: fallbackContent,
      messageType,
      metadata: {
        ...metadata,
        heartbeatFallbackPosted: true,
        heartbeatFallbackReason: metadata?.heartbeatFallbackReason || 'guardrail',
      },
      agentUser,
      displayName,
    });
    return {
      success: true,
      message: posted.message,
      summary: posted.summary
        ? {
          id: (posted.summary as { _id?: unknown })._id?.toString?.() || (posted.summary as { _id?: unknown })._id,
          type: (posted.summary as { type?: string }).type,
        }
        : null,
      fallbackPosted: true,
    };
  }

  static isHeartbeatDiagnosticContent(content: unknown): boolean {
    const text = String(content || '').trim();
    if (!text) return false;

    const patterns = [
      /\bcommonly pod service is (?:not running|still not running)\b/i,
      /\bunable to (?:get|read|fetch) (?:the )?pod activity\b/i,
      /\bunable to access (?:the )?pod(?:'|')s? recent activity(?: directly)?\b/i,
      /\bcannot determine if there has been (?:any )?recent activity\b/i,
      /\bunable to retrieve any meaningful new signals?\b/i,
      /\bunable to access (?:the )?pod(?:'s)? activity data\b/i,
      /\brequired commonly tools are not available\b/i,
      /\bcannot perform (?:the )?required pod activity check\b/i,
      /\bapi calls? .* consistently failing\b/i,
      /\bpersistent issue with accessing (?:the )?pod(?:'s)? data\b/i,
      /\brequests? (?:are|were) returning errors?\b/i,
      /\bcommonly channel configuration (?:doesn(?:'|')t|does not) support\b/i,
      /\boperations? i need to check recent activity\b/i,
      /\bauthentication issue\b/i,
      /\bnetwork problem\b/i,
      /\bendpoints? (?:are|were|is)n(?:'|')t accessible\b/i,
      /\bcan(?:'|')t retrieve (?:the )?pod(?:'s)? current activity\b/i,
      /\bcannot retrieve (?:the )?pod(?:'s)? current activity\b/i,
      /\bpod .* (?:doesn(?:'|')t exist|isn(?:'|')t accessible)\b/i,
      /\bpod appears to be unavailable\b/i,
      /\bpod .* id is incorrect\b/i,
      /\bno activity hint in the payload\b/i,
      /\bno activity hint in the payload to check for recent activity\b/i,
      /\bconnectivity or authentication problem\b/i,
      /\bmissing tokens?\b/i,
      /\bpermission error\b.*\bpod context\b/i,
      /\bunable to retrieve (?:the )?pod context\b.*\bmessage tool\b/i,
      /\bnot a valid channel id\b/i,
      /\bneed to use the correct tool\b/i,
      /\bpermission denied\b/i,
      /\bforbidden\b/i,
    ];
    return patterns.some((pattern) => pattern.test(text));
  }

  static logMessageLifecycle(action: string, details: Record<string, unknown> = {}): void {
    const parts = [
      `[agent-message] ${action}`,
      `agent=${details.agentName || 'unknown'}`,
      `instance=${details.instanceId || 'default'}`,
      `pod=${details.podId || 'n/a'}`,
      `sourceEventType=${details.sourceEventType || 'n/a'}`,
      `sourceEventId=${details.sourceEventId || 'n/a'}`,
    ];
    if (details.messageId) parts.push(`messageId=${details.messageId}`);
    if (details.reason) parts.push(`reason=${details.reason}`);
    if (details.dedupeWindowMinutes) parts.push(`dedupeWindowMinutes=${details.dedupeWindowMinutes}`);
    console.log(parts.join(' '));
  }

  static normalizeForDedupe(content: unknown): string {
    return String(content || '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Consecutive messages one agent may post with nobody else speaking.
   *
   * Tunable rather than hardcoded, and 0 disables it — the same shape as every
   * other governor here, because a cap whose right value is unknown should be
   * adjustable without a deploy. 3 matches the `commonly_post_message`
   * guidance, so the tool description and the kernel state one number.
   */
  /**
   * Is this pod a strict 1:1, where a run of one speaker's messages is just an
   * answer rather than a monologue?
   *
   * Prefers `agentIdentityService.DM_POD_TYPES_GUARD` — the single source of
   * truth for the DM set (ADR-001 §3.10) — and falls back to the same two
   * literals if that import is unavailable. The fallback exists because a
   * PARTIAL MOCK of that module made the named export `undefined` and crashed
   * 17 tests on the first attempt: the same shape as the `notifyPodAgents`
   * partial-mock crash earlier the same day. A message must not fail to post
   * because a sibling module was stubbed.
   *
   * `agent-admin` is intentionally absent from both, matching the guard: it is
   * N:1 (several admins, one agent), so it IS a shared room and the crowding
   * rationale applies.
   */
  static isOneToOnePod(podType: unknown): boolean {
    const type = String(podType || '');
    try {
      // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
      const { DM_POD_TYPES_GUARD } = require('./agentIdentityService');
      if (DM_POD_TYPES_GUARD && typeof DM_POD_TYPES_GUARD.has === 'function') {
        return DM_POD_TYPES_GUARD.has(type);
      }
    } catch {
      // fall through to the literals below
    }
    return type === 'agent-room' || type === 'agent-dm';
  }

  static resolveConsecutiveRunCap(): number {
    const parsed = Number.parseInt(process.env.AGENT_MESSAGE_CONSECUTIVE_RUN_CAP || '', 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    return 3;
  }

  static resolveDedupeWindowMinutes(metadata: MetadataDoc = {}): number {
    const sourceEventType = String(
      metadata?.sourceEventType || metadata?.eventType || '',
    ).toLowerCase();
    if (sourceEventType === 'heartbeat') {
      const parsed = Number.parseInt(process.env.AGENT_HEARTBEAT_MESSAGE_DEDUPE_MINUTES || '', 10);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
      return 0;
    }
    const parsed = Number.parseInt(process.env.AGENT_MESSAGE_DEDUPE_WINDOW_MINUTES || '', 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    return 30;
  }

  /**
   * How many messages at the tail of this pod were posted by this author with
   * nobody else speaking in between.
   *
   * Reuses `getRecentMessages` rather than adding a query — the dedupe check
   * immediately below already pays for that fetch.
   */
  static async countConsecutiveRun(podId: unknown, userId: unknown): Promise<number> {
    const userIdString = String(userId || '');
    if (!userIdString) return 0;
    const recent = await AgentMessageService.getRecentMessages(podId, 20);
    type MessageEntry = MessageNormalized & { user_id?: string };
    let run = 0;
    for (const message of (recent as MessageEntry[]).slice().reverse()) {
      const messageUserId = String(message?.userId?._id || message?.user_id || '');
      if (!messageUserId) break;
      if (messageUserId !== userIdString) break;
      run += 1;
    }
    return run;
  }

  static async findRecentDuplicate(options: {
    podId: unknown;
    userId: unknown;
    content: unknown;
    metadata?: MetadataDoc;
  }): Promise<DuplicateResult | null> {
    const { podId, userId, content, metadata = {} } = options;
    const dedupeWindowMinutes = AgentMessageService.resolveDedupeWindowMinutes(metadata);
    if (!dedupeWindowMinutes || dedupeWindowMinutes <= 0) return null;

    const target = AgentMessageService.normalizeForDedupe(content);
    if (!target) return null;

    const recent = await AgentMessageService.getRecentMessages(podId, 60);
    const cutoff = Date.now() - (dedupeWindowMinutes * 60 * 1000);
    const userIdString = String(userId || '');

    type MessageEntry = MessageNormalized & { user_id?: string };
    const hit = (recent as MessageEntry[])
      .slice()
      .reverse()
      .find((message) => {
        const messageUserId = String(message?.userId?._id || message?.user_id || '');
        if (!messageUserId || messageUserId !== userIdString) return false;
        const createdAt = new Date(String(message?.createdAt || 0)).valueOf();
        if (!Number.isFinite(createdAt) || createdAt < cutoff) return false;
        return AgentMessageService.normalizeForDedupe(message?.content || '') === target;
      });

    if (!hit) return null;
    return {
      id: hit.id || hit._id || null,
      createdAt: hit.createdAt || null,
      dedupeWindowMinutes,
    };
  }

  static extractStructuredSummary(content: unknown, metadata: MetadataDoc = {}): StructuredSummary | null {
    const result: StructuredSummary = {
      summaryType: metadata?.summaryType || null,
      title: metadata?.title || metadata?.summary?.title || null,
      body: metadata?.summary?.content || metadata?.summaryContent || null,
      timeRange: metadata?.summary?.timeRange || metadata?.timeRange || null,
      messageCount: metadata?.summary?.messageCount
        || metadata?.messageCount
        || metadata?.summary?.totalItems
        || metadata?.totalItems
        || 0,
      source: metadata?.source || null,
      eventId: (metadata?.eventId as string) || null,
    };

    if (result.body) {
      return result;
    }

    const raw = String(content || '').trim();
    if (!raw.startsWith('[BOT_MESSAGE]')) {
      return null;
    }

    const payloadRaw = raw.replace(/^\[BOT_MESSAGE\]/, '');
    try {
      const parsed: Record<string, unknown> = JSON.parse(payloadRaw);
      return {
        summaryType: result.summaryType || (parsed.summaryType as string) || (parsed.type as string) || 'chats',
        title: result.title || (parsed.title as string) || null,
        body: (parsed.summary as string) || (parsed.content as string) || null,
        timeRange: result.timeRange || (parsed.timeRange as StructuredSummary['timeRange']) || null,
        messageCount: result.messageCount || (parsed.messageCount as number) || 0,
        source: result.source || (parsed.source as string) || (parsed.sourceLabel as string) || 'agent',
        eventId: result.eventId || (parsed.eventId as string) || null,
      };
    } catch (error) {
      return null;
    }
  }

  static mapSummaryType(summaryType: unknown): string {
    const normalized = String(summaryType || 'chats').toLowerCase();
    if (normalized.includes('daily')) return 'daily-digest';
    if (normalized.includes('post')) return 'posts';
    return 'chats';
  }

  static async persistSummaryFromAgentMessage(options: {
    agentName: string;
    podId: unknown;
    content: unknown;
    metadata: MetadataDoc;
  }): Promise<unknown> {
    const { agentName, podId, content, metadata } = options;
    const structured = AgentMessageService.extractStructuredSummary(content, metadata);
    if (!structured?.body) return null;

    const summaryType = AgentMessageService.mapSummaryType(structured.summaryType);
    const now = new Date();
    const defaultStart = new Date(now.getTime() - (60 * 60 * 1000));
    const start = structured.timeRange?.start ? new Date(structured.timeRange.start) : defaultStart;
    const end = structured.timeRange?.end ? new Date(structured.timeRange.end) : now;

    // `structured.eventId` comes from caller-supplied metadata and reaches a
    // Mongo query object, so an object value (`{$ne: null}`) would be operator
    // injection rather than a lookup. `extractStructuredSummary` only CASTS it
    // to string in TypeScript, which changes nothing at runtime.
    //
    // Sanitized with strip-via-replace rather than `String()` deliberately:
    // that is the shape CodeQL recognises as a SqlSanitizer for
    // js/sql-injection, as registry/install.ts:114-120 already documents for
    // the same reason. It also genuinely fixes it — the coercion collapses a
    // non-string to a scalar, and the strip leaves an id charset.
    const safeEventId = String(structured.eventId ?? '').replace(/[^a-zA-Z0-9:_-]/g, '');
    if (safeEventId) {
      const existing = await Summary.findOne({
        podId,
        type: summaryType,
        'metadata.eventId': safeEventId,
      });
      if (existing) return existing;
    }

    const summary = await Summary.create({
      type: summaryType,
      podId: summaryType === 'daily-digest' ? undefined : podId,
      title: structured.title || `${agentName} Summary`,
      content: structured.body,
      timeRange: { start, end },
      metadata: {
        totalItems: Number.isFinite(structured.messageCount) ? structured.messageCount : 0,
        podName: metadata?.podName || undefined,
        source: structured.source || 'agent',
        sources: structured.source ? [structured.source] : [],
        eventId: structured.eventId || undefined,
      },
    });

    if (summaryType !== 'daily-digest') {
      try {
        await PodAssetService.createChatSummaryAsset({ podId, summary });
      } catch (assetError) {
        const err = assetError as { message?: string };
        console.warn('Failed to persist summary pod asset from agent message:', err.message);
      }
    }

    return summary;
  }

  static async postMessage(options: PostMessageOptions): Promise<Record<string, unknown>> {
    const {
      agentName,
      podId,
      content,
      metadata = {},
      messageType = 'text',
      payload = null,
      instanceId = 'default',
      displayName,
      replyToMessageId = null,
      threadRootId = null,
      installationConfig = null,
    } = options;

    // Typing indicator cleanup — once postMessage is entered, the runtime has
    // handed us the agent's output, so the "typing" state is over no matter
    // which code path wins below (post, skip, dedupe, error). We emit stop
    // eagerly here and wrap the rest of the function in a try/catch so that
    // any throw still benefits from the stop we already sent.
    try {
      agentTypingService.emitAgentTypingStop({ podId, agentName, instanceId });
    } catch (typingError) {
      console.warn('[agent-typing] stop (postMessage entry) failed:', (typingError as Error).message);
    }

    if (!agentName || !podId) {
      throw new Error('agentName and podId are required');
    }
    let sanitizedContent = AgentMessageService.sanitizeAgentContent(content);

    // Suppress runtime model-failure errors. When a runtime's model chain is
    // exhausted (bad/missing provider auth, 429s, all fallbacks down) the
    // gateway posts the raw failover error AS the agent's "reply" — e.g.
    // "⚠️ Agent failed before reply: All models failed (4): openrouter/...: 401".
    // Those are operator diagnostics, never user-facing content; left alone they
    // spam every pod the agent heartbeats in (~every 30 min). Treat them like a
    // silent reply (empty → skipped below) and log instead, so a degraded
    // community agent fails quietly rather than flooding chat.
    if (sanitizedContent && AgentMessageService.isRuntimeModelFailure(sanitizedContent)) {
      console.warn(`[agent-msg] suppressed runtime model-failure from agent=${agentName} instance=${instanceId} pod=${podId}: ${sanitizedContent.slice(0, 120)}`);
      sanitizedContent = '';
    }

    // Same treatment for gateway tool-status failure notes ("⚠️ 📝 Edit: ...
    // failed") — operator diagnostics that were spamming pods once per
    // failed workspace-file edit. Logged for observability, never posted.
    if (sanitizedContent && AgentMessageService.isRuntimeToolFailureNote(sanitizedContent)) {
      console.warn(`[agent-msg] suppressed runtime tool-failure note from agent=${agentName} instance=${instanceId} pod=${podId}: ${sanitizedContent.slice(0, 120)}`);
      sanitizedContent = '';
    }

    // Task #68: detect false-attachment claims. Agents sometimes post
    // "Done — I attached the file" without actually calling
    // commonly_attach_file. The file may exist in their workspace but
    // never lands in pod chat. Annotate the message so humans can see
    // the discrepancy at a glance rather than wonder where the file went.
    // Heuristic only — false positives are tolerable (footer is
    // informational, doesn't reject). Pattern: first-person or
    // sentence-initial past-tense declarative ("attached" /
    // "uploaded" / "posted") with a file-object noun nearby AND no
    // `[[upload:` directive in the body.
    if (sanitizedContent && typeof sanitizedContent === 'string') {
      // Scanned over a BOUNDED prefix, not the whole message. The claim
      // pattern below contains `\s+` and `[^.\n]{0,80}` runs, which CodeQL
      // flags as polynomial ReDoS (js/polynomial-redos) — and this input is
      // agent-authored, so it is attacker-influenced in exactly the way that
      // matters. Capping the scan makes the work constant regardless of
      // message size.
      //
      // The cap costs nothing real: the pattern targets a first-person or
      // sentence-initial declarative, which is how such a claim opens. A
      // false-attach claim buried past the cap goes unwarned — the same
      // outcome as before for any message that never matched, and strictly
      // better than a service that can be stalled by a long one.
      const scanned = sanitizedContent.slice(0, ATTACH_CLAIM_SCAN_LIMIT);
      const hasUploadDirective = /\[\[upload:/i.test(sanitizedContent);
      const claimsAttachment = /(?:\b(?:i(?:'ve| have)?|done\s*[—-]?\s*i|i\s+just|i\s+already)\s+|(?:^|[.!?]\s+|[\r\n]+)(?:done\s*[—-]?\s*)?(?:just\s+)?)(?:attached|uploaded|posted)\b[^.\n]{0,80}\b(?:file|deck|attachment|runbook|pptx|docx|xlsx|pdf|csv|image|artifact)\b/i.test(scanned);
      if (claimsAttachment && !hasUploadDirective) {
        // Suppress the warning when THIS agent genuinely attached a file to
        // this pod moments ago. `commonly_attach_file` posts the clean
        // directive message AND the agent then posts a natural-language
        // "Done — attached the deck" follow-up; that follow-up legitimately
        // has no `[[upload:]]` directive of its own, but the attachment
        // really happened. Without this check the guard false-positives on
        // every successful tool-driven attach (smoke 2026-06-26). We look
        // for a File row this agent uploaded to this pod inside a short
        // window — informational-only, so a miss just restores the old
        // (over-eager) behaviour rather than blocking the message.
        let recentlyAttached = false;
        try {
          if (podId && mongoose.Types.ObjectId.isValid(podId)) {
            const botUsername = AgentIdentityService.buildAgentUsername(agentName, instanceId);
            const botUser = await User.findOne({ username: botUsername }).select('_id').lean();
            if (botUser && botUser._id) {
              const since = new Date(Date.now() - RECENT_ATTACH_WINDOW_MS);
              const recentFile = await File.findOne({
                podId: new mongoose.Types.ObjectId(String(podId)),
                uploadedBy: botUser._id,
                createdAt: { $gte: since },
              }).select('_id').lean();
              recentlyAttached = !!recentFile;
            }
          }
        } catch (recentAttachErr) {
          // Lookup failure → fall back to the original warning behaviour.
          console.warn(`[agent-msg] recent-attach lookup failed: ${(recentAttachErr as Error).message}`);
        }
        if (!recentlyAttached) {
          sanitizedContent += '\n\n⚠️ _(system note: this message claims an attachment but no `[[upload:...]]` directive is in the body. The agent may not have actually called `commonly_attach_file`. Check the agent\'s workspace for the file and re-attach if needed.)_';
          console.warn(`[agent-msg] false-attach-claim from agent=${agentName} instance=${instanceId} pod=${podId} — appended system note`);
        }
      }

      // Round 2 of the false-attach defence (smoke 2026-05-20): the previous
      // check only catches "Done — I attached..." narration with NO directive.
      // It does NOT catch an agent who TYPES a `[[upload:X]]` directive as a
      // string without actually calling `commonly_attach_file` first. Aria did
      // this in cycle 11 — message contained `[[upload:smoke-postmortem-v2.md]]`
      // but the pod had zero File rows. Bypasses the directive-presence check
      // entirely because the substring is there.
      //
      // Fix: when a directive IS present, validate its first segment against
      // the File collection scoped to this podId. Agents are taught the
      // canonical format `[[upload:<id>|<name>|<size>|<kind>]]` (pod-context
      // cue in agentMentionService); the first segment is the storage key
      // (matches File.fileName). For tolerance with agents that put a human
      // name in the first slot, also check File.originalName. Any directive
      // whose first segment matches NEITHER → fake. Append a different system
      // note so operators can tell the two failure modes apart.
      //
      // Heuristic / informational only — never rejects the message. Per-podId
      // single-query batching (an $in over all referenced names) keeps the
      // hot-path cost flat regardless of how many directives a message has.
      if (hasUploadDirective && podId) {
        try {
          const directivePattern = /\[\[upload:([^|\]]+)/gi;
          const referencedNames: string[] = [];
          let match;
          while ((match = directivePattern.exec(sanitizedContent)) !== null) {
            // Coerce + sanitize each captured name before it reaches the
            // Mongoose query — CodeQL doesn't trust regex output as a
            // SqlSanitizer for the NoSQL-injection query, so we apply the
            // same String().replace() pattern documented at
            // routes/registry/install.ts:114-116. The pattern strips
            // anything that isn't a filename-safe char, which also blocks
            // the `{$ne: null}` / array-injection vectors the rule guards
            // against. We also bound length to keep a malformed directive
            // from blowing up the query.
            const captured = match[1] === undefined ? '' : String(match[1]);
            const sanitized = captured
              .trim()
              .replace(/[^A-Za-z0-9._\-/+ ]/g, '')
              .slice(0, 256);
            if (sanitized && !referencedNames.includes(sanitized)) {
              referencedNames.push(sanitized);
            }
          }
          if (referencedNames.length > 0 && mongoose.Types.ObjectId.isValid(podId)) {
            // Single-query, in-memory set comparison.
            //
            // History on this hot path: tried `$in` and per-name findOne
            // with progressively stricter sanitizers (String+replace+
            // roundtrip+regex.test, 5 gates). CodeQL's js/nosql-injection
            // analyzer kept flagging the query value as user-tainted
            // because the source ultimately traces back to a regex
            // capture from message content — the analyzer doesn't trust
            // the .replace() chain on regex captures the way it does on
            // direct String() of req.body.
            //
            // The cleaner refactor — and the one the analyzer can't
            // object to: fetch ALL of this pod's files in one query
            // keyed ONLY by `podId` (which is the validated route/
            // session pod, not user content), build an in-memory Set
            // of the legitimate names, then do the phantom check
            // purely in JS. The user-tainted directive names never
            // enter a Mongoose filter.
            //
            // Perf: a single round-trip per message instead of N
            // per-directive lookups. Bound the fetch with .limit(500)
            // so a pathologically large pod can't blow up the message
            // pipeline — 500 is well above any realistic pod-file
            // count (typical: 10-100; even Nova's YC pitch pod after
            // a heavy artifact day had ~30).
            // podId is guarded by the `mongoose.Types.ObjectId.isValid(podId)`
            // check at the outer `if` above — that's the canonical CodeQL
            // SqlSanitizer pattern for Mongo ObjectId fields. Cast through
            // `new ObjectId(...)` here so the analyzer sees a definitely-
            // safe ObjectId in the query, not a passed-in string.
            const safePodId = new mongoose.Types.ObjectId(String(podId));
            const podFiles = await File.find({ podId: safePodId })
              .select('fileName originalName')
              .limit(FILE_DIRECTIVE_SCAN_LIMIT)
              .lean();
            const knownNames = new Set<string>();
            for (const f of podFiles) {
              if (f.fileName) knownNames.add(String(f.fileName));
              if (f.originalName) knownNames.add(String(f.originalName));
            }
            const phantoms = referencedNames.filter((n) => typeof n === 'string' && n && !knownNames.has(n));
            if (phantoms.length > 0) {
              const phantomList = phantoms.map((n) => `\`${n}\``).join(', ');
              sanitizedContent += `\n\n⚠️ _(system note: this message references ${phantoms.length === 1 ? 'an upload directive' : 'upload directives'} for ${phantomList} but no matching attachment was found in this pod. The agent may have typed the directive without actually calling \`commonly_attach_file\`. Check the agent's workspace.)_`;
              console.warn(`[agent-msg] phantom-upload-directive from agent=${agentName} instance=${instanceId} pod=${podId} — names=${JSON.stringify(phantoms)}`);
            }
          }
        } catch (validationErr) {
          // Validation is informational — never block the message on a
          // lookup failure. The original directive still passes through.
          console.warn(`[agent-msg] phantom-directive lookup failed: ${(validationErr as Error).message}`);
        }
      }
    }

    if (!sanitizedContent) {
      // ADR-012 §4: agent-dm-conclusion trigger. The reply is silent
      // (NO_REPLY swallowed by sanitizeAgentContent). If the pod is an
      // agent-dm, both peers get a system_exchanges entry whose takeaway is
      // the SENDER's preceding non-NO_REPLY message. Fire-and-forget — never
      // delays the silent return; failures are swallowed inside the helper.
      void AgentMessageService.maybeRecordAgentDmConclusion({
        podId: String(podId),
        senderAgentName: agentName,
        senderInstanceId: instanceId,
      });
      return { success: true, skipped: true, reason: 'silent_or_empty' };
    }

    const agentUser: AgentUserDoc = await AgentIdentityService.getOrCreateAgentUser(agentName, {
      instanceId,
      displayName,
    });
    const pod = await AgentIdentityService.ensureAgentInPod(agentUser, podId);
    if (!pod) {
      // ensureAgentInPod returns null in two cases:
      //   1. Pod truly doesn't exist (404).
      //   2. Pod is a 1:1 DM (agent-room / agent-dm) and the agent isn't
      //      already a member — the §3.10 guard refused to add them.
      // Disambiguate with a separate Pod.findById to give callers a useful
      // error code. The post is rejected either way; the caller can
      // distinguish "delete this stale tool reference" from "you can't
      // post here, start a new DM if you need a private channel."
      // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
      const PodModel = require('../models/Pod');
      const podDoc = await PodModel.findById(podId).select('_id type').lean() as { _id?: unknown; type?: string } | null;
      if (!podDoc) {
        const err: Error & { code?: string; statusCode?: number } = new Error('Pod not found');
        err.code = 'pod_not_found';
        err.statusCode = 404;
        throw err;
      }
      // It's a 1:1 DM and this agent isn't a member.
      const err: Error & { code?: string; statusCode?: number } = new Error(
        `Agent is not a member of ${podDoc.type} pod ${podId} — DM pods are 1:1 (ADR-001 §3.10). Open a new DM via commonly_open_dm if a private channel with this peer is needed.`,
      );
      err.code = 'dm_membership_refused';
      err.statusCode = 403;
      throw err;
    }

    const isHeartbeatEvent = AgentMessageService.isHeartbeatEvent(metadata);
    const isHeartbeatHousekeeping = AgentMessageService.isHeartbeatHousekeepingContent(sanitizedContent);
    const isHeartbeatDiagnostic = AgentMessageService.isHeartbeatDiagnosticContent(sanitizedContent);
    const isErrorContent = AgentMessageService.isErrorContent(sanitizedContent);
    const routesErrorsToOwnerDM = AgentMessageService.shouldRouteErrorsToOwnerDM(installationConfig);
    const normalizedAgentName = String(agentName || '').trim().toLowerCase();
    const shouldTreatAsHeartbeatGuardrail = isHeartbeatEvent
      || (
        normalizedAgentName === 'openclaw'
        && (isHeartbeatHousekeeping || isHeartbeatDiagnostic || isErrorContent)
      );

    if (shouldTreatAsHeartbeatGuardrail && isHeartbeatHousekeeping) {
      const isExplicitHeartbeatOk = /^(HEARTBEAT_OK|HEARTBEAT_NOOP)$/i.test(sanitizedContent.trim());
      if (isHeartbeatEvent && !isExplicitHeartbeatOk && AgentMessageService.shouldPostHeartbeatFallback()) {
        return AgentMessageService.postHeartbeatFallback({
          agentName,
          instanceId,
          podId,
          messageType,
          metadata: { ...metadata, heartbeatFallbackReason: 'housekeeping' },
          agentUser,
          displayName,
          sourceContent: sanitizedContent,
        });
      }
      AgentMessageService.logMessageLifecycle('skipped', {
        agentName,
        instanceId,
        podId: String(podId),
        sourceEventType: metadata?.sourceEventType || metadata?.eventType,
        sourceEventId: metadata?.sourceEventId || metadata?.eventId,
        reason: 'heartbeat_housekeeping',
      });
      return { success: true, skipped: true, reason: 'heartbeat_housekeeping' };
    }

    if (
      isHeartbeatEvent
      && AgentMessageService.isLowValueHeartbeatContent(sanitizedContent)
      && AgentMessageService.shouldPostHeartbeatFallback()
    ) {
      return AgentMessageService.postHeartbeatFallback({
        agentName,
        instanceId,
        podId,
        messageType,
        metadata: { ...metadata, heartbeatFallbackReason: 'low_value' },
        agentUser,
        displayName,
        sourceContent: sanitizedContent,
      });
    }

    if (isHeartbeatEvent) {
      const isDuplicate = await AgentMessageService.hasRecentDuplicateUrls({
        podId,
        content: sanitizedContent,
        authorUserId: agentUser?._id,
      });
      if (isDuplicate) {
        AgentMessageService.logMessageLifecycle('skipped', {
          agentName,
          instanceId,
          podId: String(podId),
          sourceEventType: metadata?.sourceEventType || metadata?.eventType,
          sourceEventId: metadata?.sourceEventId || metadata?.eventId,
          reason: 'duplicate_urls',
        });
        return { success: true, skipped: true, reason: 'duplicate_urls' };
      }
    }

    if (
      isHeartbeatEvent
      && AgentMessageService.extractMentionHandles(sanitizedContent).length === 0
      && AgentMessageService.shouldRequireHeartbeatMention(installationConfig)
      && AgentMessageService.shouldPostHeartbeatFallback()
      && !(routesErrorsToOwnerDM && (isHeartbeatDiagnostic || isErrorContent))
    ) {
      return AgentMessageService.postHeartbeatFallback({
        agentName,
        instanceId,
        podId,
        messageType,
        metadata: { ...metadata, heartbeatFallbackReason: 'missing_mentions' },
        agentUser,
        displayName,
        sourceContent: sanitizedContent,
      });
    }

    if (shouldTreatAsHeartbeatGuardrail && (isHeartbeatDiagnostic || isErrorContent)) {
      if (isHeartbeatEvent || routesErrorsToOwnerDM) {
        try {
          const routed = await AgentMessageService.routeErrorToDM({
            agentName,
            instanceId,
            podId,
            content: sanitizedContent,
            agentUser,
            displayName,
            messageType,
            metadata,
            postSourceNotice: false,
          });
          if (routed) {
            return { success: true, routedToDM: true, dmPodId: routed.dmPodId };
          }
        } catch (routeError) {
          const err = routeError as { message?: string };
          console.warn('Heartbeat DM routing failed, suppressing pod error post:', err.message);
        }
      }

      AgentMessageService.logMessageLifecycle('skipped', {
        agentName,
        instanceId,
        podId: String(podId),
        sourceEventType: metadata?.sourceEventType || metadata?.eventType,
        sourceEventId: metadata?.sourceEventId || metadata?.eventId,
        reason: 'heartbeat_diagnostic_suppressed',
      });
      return { success: true, skipped: true, reason: 'heartbeat_diagnostic_suppressed' };
    }

    const sourcePod = (routesErrorsToOwnerDM && isErrorContent)
      ? await Pod.findById(podId).select('type').lean() as { type?: string } | null
      : null;
    if (routesErrorsToOwnerDM && isErrorContent && sourcePod?.type !== 'agent-admin') {
      try {
        const shouldPostSourceNotice = normalizedAgentName !== 'openclaw';
        const routed = await AgentMessageService.routeErrorToDM({
          agentName,
          instanceId,
          podId,
          content: sanitizedContent,
          agentUser,
          displayName,
          messageType,
          metadata,
          postSourceNotice: shouldPostSourceNotice,
        });
        if (routed) {
          return { success: true, routedToDM: true, dmPodId: routed.dmPodId };
        }
      } catch (routeError) {
        const err = routeError as { message?: string };
        console.warn('DM routing failed, posting error in original pod:', err.message);
      }
    }

    const dedupePod = sourcePod || (await Pod.findById(podId).select('type').lean() as { type?: string } | null);
    const isAgentAdminPod = dedupePod?.type === 'agent-admin';
    if (!isAgentAdminPod) {
      const duplicate = await AgentMessageService.findRecentDuplicate({
        podId,
        userId: agentUser._id,
        content: sanitizedContent,
        metadata,
      });
      if (duplicate) {
        AgentMessageService.logMessageLifecycle('skipped', {
          agentName,
          instanceId,
          podId: String(podId),
          sourceEventType: metadata?.sourceEventType || metadata?.eventType,
          sourceEventId: metadata?.sourceEventId || metadata?.eventId,
          reason: 'duplicate_recent',
          dedupeWindowMinutes: duplicate.dedupeWindowMinutes,
        });
        return { success: true, skipped: true, reason: 'duplicate_recent', duplicate };
      }

      // ── Consecutive-run cap ────────────────────────────────────────────
      //
      // Ruled by @fable-lead, which named this chokepoint over the wrapper for
      // a reason it could demonstrate on itself: "my posts ride MCP and no
      // wrapper ever saw them." Every agent post from every tier — MCP,
      // wrapper, moltbot, native — passes through here. A wrapper-side cap
      // would have missed exactly the seats that post most.
      //
      // What this bounds that the rate cap could not: sprint-review posted 24
      // consecutive messages over 433s and pod-architect 21 over 379s, both
      // inside the documented "3 messages per minute". A rate limits how FAST
      // an agent talks and never how LONG it holds the floor.
      //
      // The refusal STEERS rather than silences — also fable's ruling, and the
      // whole failure family this session: a bare refusal converts a monologue
      // into silence, which reads as a considered decision.
      //
      // What overflow becomes CHANGED (Sam 57691, @ux-lead's copy 57694). It
      // used to become an attachment, and the paragraph below already records
      // why that was wrong in a DM. The same objection holds in a shared room
      // and nobody had drawn the line: a colleague's considered answer arriving
      // as a file is un-quotable, un-followable and read all-or-nothing. Now it
      // becomes a THREAD under the agent's own first message.
      //
      // The cap keeps binding inside that thread — `countConsecutiveRun` reads
      // the pod's recent messages with no thread filter, so a threaded run
      // counts exactly like a top-level one. That is the point rather than a
      // gap: the cap bounds how long you hold the floor, and threading changes
      // where the rest of the answer lives, not how much of it you get to say
      // uninterrupted.
      // NOT in a 1:1. The cap's entire rationale is "do not crowd others out of
      // a shared room", and in a DM there is no room to crowd: the only other
      // participant is the person who asked. Sam caught this within hours of it
      // shipping — @ux-lead answered a three-part design question in an
      // agent-room, hit the cap, and attached its reply as a .md. A colleague's
      // considered answer arriving as a file you must open is strictly worse
      // than the monologue the cap exists to prevent, and it converts a
      // conversation into a document — the same "report surface" failure the
      // tool description warns about, reached from the opposite direction.
      //
      // `agent-admin` is deliberately NOT exempt: it is N:1 (several admins,
      // one agent), so it is a shared room and the crowding rationale holds.
      // Same reasoning as its exclusion from DM_POD_TYPES_GUARD.
      const isOneToOne = AgentMessageService.isOneToOnePod(dedupePod?.type);

      const runCap = isOneToOne ? 0 : AgentMessageService.resolveConsecutiveRunCap();
      if (runCap > 0) {
        const run = await AgentMessageService.countConsecutiveRun(podId, agentUser._id);
        if (run >= runCap) {
          AgentMessageService.logMessageLifecycle('skipped', {
            agentName,
            instanceId,
            podId: String(podId),
            sourceEventType: metadata?.sourceEventType || metadata?.eventType,
            sourceEventId: metadata?.sourceEventId || metadata?.eventId,
            reason: 'consecutive_run_cap',
            consecutive: run,
          });
          return {
            success: false,
            refused: true,
            reason: 'consecutive_run_cap',
            consecutive: run,
            guidance: `Not posted: you have already sent ${run} messages in a row here `
              + 'with nobody else speaking. That is a monologue whatever its rate, and the '
              + 'room reads it as one wall. Do ONE of these instead: (a) if the remaining '
              + 'material is substantial, continue it in a THREAD under your first message '
              + '(threadRootId = that message id) — not as a file, and @mention whoever '
              + 'needs it, because a thread wakes only the people who have posted in it; '
              + 'the cap still binds '
              + 'inside the thread, which is the point; (b) if it can wait, wait for '
              + 'someone else to speak; (c) if it was not worth saying, drop it. Attach a '
              + 'file only for a genuine artifact (a diff, an image, a generated doc), '
              + 'never for the rest of your message. Do not retry this '
              + 'message unchanged — it will be refused again.',
          };
        }
      }
    }

    const posted = await AgentMessageService._postToTarget({
      agentName,
      instanceId,
      podId,
      content: sanitizedContent,
      messageType,
      metadata,
      payload,
      agentUser,
      displayName,
      replyToMessageId,
      threadRootId,
    });

    return {
      success: true,
      message: posted.message,
      summary: posted.summary
        ? {
          id: (posted.summary as { _id?: unknown })._id?.toString?.() || (posted.summary as { _id?: unknown })._id,
          type: (posted.summary as { type?: string }).type,
        }
        : null,
    };
  }

  static async routeErrorToDM(options: RouteErrorOptions): Promise<{ routedToDM: true; dmPodId: unknown } | null> {
    const {
      agentName, instanceId = 'default', podId, content, agentUser, displayName,
      messageType = 'text', metadata = {}, postSourceNotice = true,
    } = options;

    const ownerId = await DMService.resolveAgentOwner(agentName, podId, instanceId);
    const dmPod = await DMService.getOrCreateAdminDMPod(agentUser._id, ownerId, { agentName, instanceId });

    const dmPrefix = `[Error in pod ${podId}]`;
    await AgentMessageService._postToTarget({
      agentName,
      instanceId,
      podId: dmPod._id,
      content: `${dmPrefix}\n\n${content}`,
      messageType,
      metadata,
      agentUser,
      displayName,
    });

    if (postSourceNotice) {
      await AgentMessageService._postToTarget({
        agentName,
        instanceId,
        podId,
        content: '[Encountered an issue - details sent to debug DM]',
        messageType: 'system',
        metadata,
        agentUser,
        displayName,
        skipDeliveryUpdate: true,
        skipSummaryPersistence: true,
      });
    }

    return { routedToDM: true, dmPodId: dmPod._id };
  }

  static async _postToTarget(options: PostTargetOptions): Promise<{ message: MessageNormalized; summary: unknown }> {
    const {
      agentName, instanceId = 'default', podId, content, messageType = 'text',
      metadata = {}, payload = null, agentUser, displayName, replyToMessageId = null, threadRootId = null, skipDeliveryUpdate = false, skipSummaryPersistence = false,
    } = options;

    // The installation label belongs to this pod; the User label belongs to
    // the portable principal. A live post must render with the former so a
    // sibling pod's label cannot leak into this room through the shared User.
    const senderDisplayName = displayName || agentUser?.botMetadata?.displayName || agentUser?.username;
    let message: MessageNormalized | null = null;

    // Resolve the explicit thread target BEFORE the PG try, and let a
    // ThreadRootError propagate: inside the try it would be swallowed into
    // the Mongo fallback and the post would land silently un-threaded —
    // the exact data loss the resolver exists to prevent. Same five
    // rejections as the human composer path (messageController). And a
    // thread-scoped post cannot be honored without PG at all, so refuse
    // loudly there too (mirror of the getRecentMessages read refusal).
    let resolvedThreadRootId: number | null = null;
    if (threadRootId != null && threadRootId !== '') {
      if (!PGMessage || !process.env.PG_HOST) {
        throw new Error('threadRootId posts require the PostgreSQL message store');
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
      const { resolveThreadRoot } = require('./threadRootResolver');
      resolvedThreadRootId = await resolveThreadRoot({
        podId: String(podId), replyToMessageId, threadRootId,
      });
    }

    if (PGMessage && process.env.PG_HOST) {
      try {
        await AgentIdentityService.syncUserToPostgreSQL(agentUser);
        // Best-effort PG pod backfill — same heal the human message paths
        // do (messageController/pgMessageController via syncPodFromMongo).
        // Mongo-only pods (e.g. the default "My Workspace" every signup
        // gets from createDefaultWorkspacePod) have no row in PG `pods`,
        // so without this the insert below FK-fails on messages_pod_id_fkey
        // and the agent's message strands in the Mongo fallback — invisible
        // to pod chat, which reads PG. Found in the 2026-07-03 live smoke:
        // the BYO hero path ("install agent → talk to it") broke at the
        // agent's first reply. Swallow errors: if PG is truly down the
        // create below throws and the existing Mongo fallback handles it.
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
          const PGPod = require('../models/pg/Pod');
          const pgPodExists = await PGPod.findById(String(podId));
          if (!pgPodExists) {
            // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
            const { syncPodFromMongo } = require('./pgPodSyncService');
            await syncPodFromMongo(String(podId), String(agentUser._id));
          }
        } catch (syncErr) {
          console.warn('[agent-msg] PG pod backfill skipped:', (syncErr as Error).message);
        }
        const newMessage = await (PGMessage as {
          create(podId: string, userId: string, content: string, type: string, replyToMessageId?: string | null, payload?: unknown, resolvedThreadRootId?: number | null): Promise<Record<string, unknown>>;
        }).create(
          String(podId),
          String(agentUser._id),
          content,
          messageType,
          replyToMessageId,
          payload,
          resolvedThreadRootId,
        );

        // The raw INSERT row carries no reply JOIN, so a replying agent's
        // broadcast would lack the quoted context until reload (#646).
        // Re-fetch only when this is actually a reply; never let a failed
        // re-fetch fall through to the Mongo path (that would duplicate the
        // already-created PG row).
        let replyTo: { id: string; content: string; username: string; userId: string } | null = null;
        if (replyToMessageId && newMessage.id) {
          try {
            const joined = await (PGMessage as {
              findById(id: string): Promise<{ replyTo?: typeof replyTo } | null>;
            }).findById(String(newMessage.id));
            replyTo = joined?.replyTo ?? null;
          } catch (joinErr) {
            console.warn('[agent-msg] reply join re-fetch failed:', (joinErr as Error).message);
          }
        }

        message = {
          _id: newMessage.id,
          id: newMessage.id,
          content: newMessage.content as string,
          messageType: (newMessage.message_type as string) || messageType,
          replyTo,
          userId: {
            _id: agentUser._id,
            username: senderDisplayName || 'Unknown',
            profilePicture: agentUser.profilePicture,
          },
          username: senderDisplayName || 'Unknown',
          profile_picture: agentUser.profilePicture,
          createdAt: newMessage.created_at as Date,
          metadata,
          ...(payload != null ? { payload: newMessage.payload ?? payload } : {}),
          // Threading: the INSERT already derived this (or NULL for a
          // non-reply); dropping it here was one of the two closed literals
          // that made agent replies arrive over the socket root-less.
          thread_root_id: (newMessage.thread_root_id as number | string | null) ?? null,
        };
      } catch (pgError) {
        console.error('PostgreSQL message creation failed, falling back to MongoDB:', pgError);
      }
    }

    if (!message && resolvedThreadRootId != null) {
      // PG accepted the resolve but the INSERT failed. Falling to Mongo here
      // would strand an explicitly-threaded post as an unthreaded row —
      // fail the post instead; the caller can retry.
      throw new Error('thread-scoped post failed at the PostgreSQL store');
    }

    if (!message) {
      const mongoMessage = new Message({
        content,
        userId: agentUser._id,
        podId,
        messageType,
        metadata,
        ...(payload != null ? { payload } : {}),
      });

      await mongoMessage.save();
      await mongoMessage.populate('userId', 'username profilePicture');
      message = mongoMessage as MessageNormalized;
    }

    AgentMessageService.logMessageLifecycle('posted', {
      agentName,
      instanceId,
      podId: String(podId),
      sourceEventType: metadata?.sourceEventType || metadata?.eventType,
      sourceEventId: metadata?.sourceEventId || metadata?.eventId,
      messageId: (message as MessageNormalized)?._id || (message as MessageNormalized)?.id || null,
    });

    if (!skipDeliveryUpdate) {
      try {
        const sourceEventId = metadata?.sourceEventId || metadata?.eventId;
        if (sourceEventId) {
          await AgentEventService.markPosted(sourceEventId, agentName, instanceId, {
            messageId: (message as MessageNormalized)?._id || (message as MessageNormalized)?.id || null,
          });
        }
      } catch (eventError) {
        const err = eventError as { message?: string };
        console.warn('Failed to update agent event delivery outcome:', err.message);
      }
    }

    let persistedSummary: unknown = null;
    if (!skipSummaryPersistence) {
      try {
        persistedSummary = await AgentMessageService.persistSummaryFromAgentMessage({
          agentName,
          podId,
          content,
          metadata,
        });
      } catch (summaryError) {
        const err = summaryError as { message?: string };
        console.warn('Failed to persist summary from agent message:', err.message);
      }
    }

    try {
      const io = socketConfig.getIO();
      const formattedMessage = {
        _id: (message as MessageNormalized)._id || (message as MessageNormalized).id,
        id: (message as MessageNormalized)._id || (message as MessageNormalized).id,
        // pod_id + podId are LOAD-BEARING for cross-pod leak protection.
        // V2PodsSidebar joins every member-pod's socket room to power
        // unread badges, so a user viewing pod A is simultaneously
        // subscribed to pod B's room. The frontend filter in
        // useV2PodDetail (`normalized.pod_id !== podId → drop`) only
        // works when this field is populated. Without it, an agent
        // posting to pod B renders live in pod A's view (and corrects
        // on refresh because the PG re-fetch is podId-scoped).
        pod_id: String(podId),
        podId: String(podId),
        content: (message as MessageNormalized).content,
        messageType: (message as MessageNormalized).messageType || messageType,
        userId: (message as MessageNormalized).userId || {
          _id: agentUser._id,
          username: senderDisplayName,
          profilePicture: agentUser.profilePicture,
        },
        username: (message as MessageNormalized).username || senderDisplayName,
        profile_picture: (message as MessageNormalized).profile_picture || agentUser.profilePicture,
        createdAt: (message as MessageNormalized).createdAt,
        metadata: (message as MessageNormalized).metadata || metadata,
        // ADR-020 D3: card payloads ride the broadcast, same reason as
        // replyTo below — the literal is a whitelist, absent fields vanish.
        payload: (message as MessageNormalized).payload ?? payload ?? null,
        // Reply quote rides the broadcast so live viewers see the quoted
        // context without a reload (#646).
        replyTo: (message as MessageNormalized).replyTo ?? null,
        // Thread root rides the broadcast for the same whitelist reason: the
        // live view folds a reply under its thread card only if this field
        // arrives with the socket message; without it every agent reply
        // rendered flat until a reload re-fetched the joined row.
        thread_root_id: (message as MessageNormalized).thread_root_id ?? null,
      };

      io.to(`pod_${podId}`).emit('newMessage', formattedMessage);
    } catch (socketError) {
      console.error('Failed to emit agent socket message:', socketError);
    }

    return { message: message as MessageNormalized, summary: persistedSummary };
  }

  // ADR-012 §4: fire-and-forget hook for agent-dm-conclusion. Lives here so
  // the postMessage early-return path remains a single line. The trigger
  // module checks pod type internally — calling this from a non-agent-dm
  // pod is a no-op after one Pod.findById.
  static maybeRecordAgentDmConclusion(args: {
    podId: string;
    senderAgentName: string;
    senderInstanceId: string;
  }): Promise<void> {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const triggers = require('./systemExchangeTriggers') as {
      recordAgentDmConclusion: (a: {
        podId: string;
        senderAgentName: string;
        senderInstanceId: string;
      }) => Promise<void>;
    };
    return triggers.recordAgentDmConclusion(args);
  }

  /**
   * True when the content IS a runtime-generated model-failure error (not
   * legitimate agent prose that happens to mention an error). These are posted
   * by the gateway when the model chain is exhausted and must never reach
   * user-facing chat. Strict signatures only — the runtime prefix
   * ("[Embedded ]Agent failed before reply:") or the "All models failed (N):"
   * failover summary — so an agent legitimately discussing an error is untouched.
   */
  static isRuntimeModelFailure(content: unknown): boolean {
    if (!content) return false;
    const c = String(content).trim();
    if (!c) return false;
    return (
      /^(?:⚠️\s*)?(?:embedded\s+)?agent failed before reply\s*:/i.test(c)
      || /\ball models failed\s*\(\d+\)\s*:/i.test(c)
    );
  }

  /**
   * Gateway tool-status failure notes — "⚠️ 📝 Edit: in /workspace/... failed",
   * "⚠️ ✉️ Message failed". Like model failures these are runtime diagnostics
   * relayed by the gateway, not agent-authored content; live pods were
   * accumulating one per failed MEMORY.md edit (2026-07-03). Strict shape:
   * a single line starting with ⚠️ + an emoji tool tag and ending in
   * "failed", so an agent legitimately reporting a failure in prose is
   * untouched.
   */
  static isRuntimeToolFailureNote(content: unknown): boolean {
    if (!content) return false;
    const c = String(content).trim();
    if (!c || c.includes('\n')) return false;
    return /^⚠️\s*\p{Extended_Pictographic}[^:\n]{0,30}:?\s.*\bfailed\b\.?$/iu.test(c);
  }

  static isBareRuntimeArtifact(content: unknown): boolean {
    if (!content) return false;

    // TASK-042: a Codex wrapper emitted this value instead of a silent reply.
    // `sanitizeAgentContent` calls us only after it has established that the
    // value is the complete, unformatted agent payload.
    return BARE_RUNTIME_ARTIFACTS.has(String(content));
  }

  static sanitizeAgentContent(content: unknown): string {
    if (content === null || content === undefined) return '';
    const raw = String(content);
    if (!raw.trim()) return '';

    const outerFence = raw.match(/^```[^\n]*\n([\s\S]*?)```\s*$/s);
    const stripped = outerFence ? outerFence[1] : raw;
    const trimmed = stripped.trim();

    // Sentinels are total-match contracts: suppress only when the complete
    // reply consists of NO_REPLY tokens. Gateways have historically joined
    // silent blocks into "NO_REPLYNO_REPLY" (or separated duplicates with
    // whitespace), so retain that compatibility.
    if (/^(?:NO_REPLY\s*)+$/.test(trimmed)) return '';

    // A substantive fully fenced reply is explicitly code-formatted even
    // though this sanitizer removes the outer transport fence before storage.
    // Preserve sentinel mentions inside it exactly. A fenced sentinel-only
    // reply was already suppressed above so runtimes cannot bypass silence by
    // wrapping the token in a transport fence.
    if (outerFence) return trimmed;

    // Bare sentinel tokens inside a substantive reply are producer leakage;
    // matching backtick-delimited spans are deliberate mentions. Pair the
    // delimiters in a linear scan rather than running a backtracking regex on
    // user-controlled message text.
    const delimiterRuns: Array<{ start: number; end: number; length: number }> = [];
    for (let index = 0; index < trimmed.length;) {
      if (trimmed[index] !== '`') {
        index += 1;
        continue;
      }
      const start = index;
      while (index < trimmed.length && trimmed[index] === '`') index += 1;
      delimiterRuns.push({ start, end: index, length: index - start });
    }

    const pendingDelimiter = new Map<
      number,
      { start: number; end: number; length: number }
    >();
    const protectedRanges: Array<{ start: number; end: number }> = [];
    for (const run of delimiterRuns) {
      const opening = pendingDelimiter.get(run.length);
      if (opening) {
        protectedRanges.push({ start: opening.start, end: run.end });
        pendingDelimiter.delete(run.length);
      } else {
        pendingDelimiter.set(run.length, run);
      }
    }
    protectedRanges.sort((left, right) => left.start - right.start);

    const mergedRanges: Array<{ start: number; end: number }> = [];
    for (const range of protectedRanges) {
      const previous = mergedRanges[mergedRanges.length - 1];
      if (previous && range.start <= previous.end) {
        previous.end = Math.max(previous.end, range.end);
      } else {
        mergedRanges.push({ ...range });
      }
    }

    const isWordCharacter = (character: string | undefined): boolean => (
      character !== undefined
      && (
        (character >= 'A' && character <= 'Z')
        || (character >= 'a' && character <= 'z')
        || (character >= '0' && character <= '9')
        || character === '_'
      )
    );
    const sentinel = 'NO_REPLY';
    let cleaned = '';
    let cursor = 0;
    let rangeIndex = 0;
    while (cursor < trimmed.length) {
      const range = mergedRanges[rangeIndex];
      if (range && cursor === range.start) {
        cleaned += trimmed.slice(range.start, range.end);
        cursor = range.end;
        rangeIndex += 1;
        continue;
      }

      if (
        trimmed.startsWith(sentinel, cursor)
        && !isWordCharacter(trimmed[cursor - 1])
      ) {
        let sentinelEnd = cursor;
        while (trimmed.startsWith(sentinel, sentinelEnd)) {
          sentinelEnd += sentinel.length;
        }
        if (!isWordCharacter(trimmed[sentinelEnd])) {
          cursor = sentinelEnd;
          continue;
        }
      }

      cleaned += trimmed[cursor];
      cursor += 1;
    }

    // Do not map/trim individual lines here. Whitespace-sensitive payloads
    // (Python, YAML, diffs, markdown nesting) are normal agent traffic, and a
    // line-wise sanitizer previously flattened their indentation.
    const normalized = cleaned.trim();

    // Apply the artifact floor after protected inline-code ranges have been
    // copied into `cleaned`; a literal mentioned as code is not runtime noise.
    return AgentMessageService.isBareRuntimeArtifact(normalized) ? '' : normalized;
  }

  /**
   * Recent pod messages, normalized across the PG and Mongo read paths.
   *
   * `selfUserId` — when the caller is a participant (an agent runtime asking
   * "did *I* post during my turn?"), pass its user id and every returned
   * message carries an explicit `self` boolean. Answering that server-side is
   * deliberate: the client cannot safely derive its own bot username, because
   * `resolveAgentType`'s LEGACY_AGENT_MAP is server-only and `instanceId` is
   * owner-scoped and assigned at install. A client that guesses wrong silently
   * double-posts. Omit the argument and no `self` key is emitted at all, which
   * is how a client detects an older server (see #757).
   *
   * `before` is an exclusive timestamp cursor applied identically on the PG
   * and Mongo fallback paths. It must already be a validated epoch timestamp
   * so raw request values never cross this service boundary into a database
   * query and the query value cannot carry a user-controlled object shape.
   * Callers may request one extra row to determine whether an older page
   * exists without changing this array-shaped service contract for existing
   * internal consumers.
   */
  static async getRecentMessages(
    podId: unknown,
    limit = 20,
    selfUserId?: unknown,
    beforeMs?: number,
    // PG-only thread scoping. On the Mongo fallback (no threading columns)
    // this filter cannot be honored, so rather than silently returning the
    // whole pod as if it were the thread, the fallback throws — an agent
    // that asked for a thread must never mistake the pod for it.
    threadRootId?: string,
  ): Promise<MessageNormalized[]> {
    if (!podId) {
      throw new Error('podId is required');
    }
    if (beforeMs !== undefined
      && (typeof beforeMs !== 'number'
        || !Number.isFinite(beforeMs)
        || Number.isNaN(new Date(beforeMs).getTime()))) {
      throw new Error('beforeMs must be a valid epoch timestamp');
    }
    const before = beforeMs === undefined ? undefined : new Date(beforeMs);

    const selfId = selfUserId ? String(selfUserId) : null;
    const withSelf = (authorId: unknown): { self?: boolean } => (
      selfId ? { self: String(authorId ?? '') === selfId } : {}
    );

    if (PGMessage && process.env.PG_HOST) {
      try {
        const messages: Array<Record<string, unknown>> = await (PGMessage as {
          findByPodId(
            id: string,
            limit: number,
            before?: string | null,
            threadRootId?: string | null,
          ): Promise<Array<Record<string, unknown>>>;
        }).findByPodId(
          String(podId),
          limit,
          before?.toISOString() ?? null,
          threadRootId ?? null,
        );

        return messages.map((msg) => {
          const username = (msg.username as string) || 'Unknown';
          // Trust the mirrored `is_bot` column only. This used to fall back to
          // a username substring test ('-bot', endsWith 'bot', 'openclaw-'),
          // which misclassified any human named e.g. "talbot" or "abbot" as a
          // bot — and `isBot` gates the wrapper's echo suppression, so a false
          // positive silently ate that agent's reply.
          const isBot = msg.is_bot === true || msg.is_bot === 'true';
          return {
            _id: msg.id,
            id: msg.id,
            content: msg.content as string,
            messageType: (msg.message_type as string) || 'text',
            userId: {
              _id: msg.user_id,
              username,
              profilePicture: msg.profile_picture as string | undefined,
            },
            username,
            isBot,
            ...withSelf(msg.user_id),
            createdAt: msg.created_at as Date,
            // Threading structure for agent readers (TASK-052's read half):
            // the SELECT has carried these since #1106; this mapper was the
            // last literal dropping them, which is why the cue teaching
            // "continue in a thread" was held — a peer agent reading context
            // could not see that a thread existed. Explicit null = "not in a
            // thread"; the Mongo fallback below omits the keys entirely =
            // "this server cannot say" (same convention as the frontend).
            reply_to_message_id: (msg.reply_to_message_id as string | number | null) ?? null,
            thread_root_id: (msg.thread_root_id as string | number | null) ?? null,
            replyTo: (msg.replyTo as MessageNormalized['replyTo']) ?? null,
          };
        });
      } catch (pgError) {
        console.error('PostgreSQL message fetch failed, falling back to MongoDB:', pgError);
      }
    }

    if (threadRootId) {
      // See the parameter comment: honoring this on Mongo is impossible and
      // faking it (returning the pod) is worse than failing.
      throw new Error('threadRootId reads require the PostgreSQL message store');
    }

    let messageQuery = Message.find({ podId: { $eq: podId } });
    if (before) {
      messageQuery = messageQuery.where('createdAt').lt(before);
    }
    const messages: Array<Record<string, unknown>> = await messageQuery
      .sort({ createdAt: -1 })
      .limit(limit)
      // `isBot` MUST stay in this projection: it is read below, and omitting it
      // made every message on this fallback path report isBot:false, which
      // disabled the wrapper's self-post detection outright (guaranteed
      // double-posting whenever PG was unavailable).
      .populate('userId', 'username profilePicture isBot')
      .lean();

    return messages.reverse().map((msg) => {
      const userId = msg.userId as { username?: string; profilePicture?: string; isBot?: boolean; _id?: unknown } | null;
      const username = userId?.username || 'Unknown';
      return {
        _id: msg._id,
        id: msg._id,
        content: msg.content as string,
        messageType: (msg.messageType as string) || 'text',
        userId: userId || { username: 'Unknown' },
        username,
        isBot: userId?.isBot === true,
        ...withSelf(userId?._id),
        createdAt: msg.createdAt as Date,
      };
    }) as MessageNormalized[];
  }
}

module.exports = AgentMessageService;

export {};
