import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import V2Avatar from './V2Avatar';
import V2GithubPrCard, { parseGithubPrUrls } from './V2GithubPrCard';
import V2ApprovalCard from './V2ApprovalCard';
import V2DecisionCard, { type V2DecisionCardData, type V2DecisionRuling } from './V2DecisionCard';
import V2MessageActions, { type V2RenderedReaction } from './V2MessageActions';
import { V2Message } from '../hooks/useV2PodDetail';
import { formatRelativeTime } from '../utils/grouping';
import { useAuth } from '../../context/AuthContext';
import { useV2Api } from '../hooks/useV2Api';
import { getSignedAttachmentUrl } from '../../utils/signedAttachmentUrl';
import { normalizeUploadUrl } from '../../utils/apiBaseUrl';

// Minimal v2-scoped markdown renderer. Plain HTML elements (no MUI), so
// styling stays in v2.css under `.v2-msg__content`. The body comes pre-stripped
// of [[file:...]] / [[reactions:...]] tokens above, so this is purely for
// agent-authored prose: bold/italic, lists, inline code, fenced code, links.

// Match @username — letters/digits start, then letters/digits/underscore/hyphen.
// Used to wrap inline mentions in a styled pill. Capturing group keeps the
// match in `split()` output so we can render text + pill segments in order.
const MENTION_RE = /(@[a-zA-Z0-9][a-zA-Z0-9_-]*)/g;

// Walk a React children tree and replace bare `@name` text segments with a
// styled `<span>` pill. Recurses into arrays + cloned elements so mentions
// inside `<strong>`, `<em>`, list items, etc. still render correctly. Code
// blocks (`<code>`, `<pre>`) are skipped — code is verbatim, mentions in code
// are intentional and shouldn't be transformed.
const renderWithMentions = (node: React.ReactNode): React.ReactNode => {
  if (typeof node === 'string') {
    if (!node.includes('@')) return node;
    const parts = node.split(MENTION_RE);
    return parts.map((part, i) => {
      if (i % 2 === 1) {
        return (
          <span key={i} className="v2-msg__mention">{part}</span>
        );
      }
      return part;
    });
  }
  if (Array.isArray(node)) {
    return node.map((child, i) => (
      <React.Fragment key={i}>{renderWithMentions(child)}</React.Fragment>
    ));
  }
  if (React.isValidElement(node)) {
    const type = node.type;
    if (type === 'code' || type === 'pre') return node;
    const props = node.props as { children?: React.ReactNode };
    const transformed = renderWithMentions(props.children);
    return React.cloneElement(node, undefined, transformed);
  }
  return node;
};

const messageMarkdownComponents = {
  a: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props} target="_blank" rel="noopener noreferrer">{renderWithMentions(children)}</a>
  ),
  p: ({ children }: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p>{renderWithMentions(children)}</p>
  ),
  li: ({ children }: React.HTMLAttributes<HTMLLIElement>) => (
    <li>{renderWithMentions(children)}</li>
  ),
  // Inline code vs fenced code share `<code>`; only fenced code is wrapped in
  // `<pre>`. Both fall through to v2.css selectors `.v2-msg__content code`
  // and `.v2-msg__content pre`. Mentions inside code are NOT transformed.
};

interface V2MessageRowProps {
  message: V2Message;
  // DecisionRequest data is deliberately joined by the thread container,
  // not parsed from the agent's prose. The message is the durable timeline
  // anchor; the queue owns the choices and resolution state.
  decision?: V2DecisionCardData;
  onDecisionRuled?: (decisionId: string, ruling: V2DecisionRuling) => void;
  // A decision's durable ruling is an ordinary human reply. This marker only
  // supplies the small transcript label; it never turns arbitrary prose into
  // a decision result.
  isDecisionRuling?: boolean;
  isLead?: boolean;
  // Map of agent-user username → per-installation displayName, so messages
  // authored by an installed agent render as "Engineer (Nova)" instead of the
  // raw User row username "openclaw-nova". Frontend-only display layer; the
  // underlying User row is unchanged.
  agentDisplayNames?: Map<string, string>;
  // Lowercased set of strings we treat as agent author bylines (both raw
  // usernames and displayNames). The backend may serve either shape on
  // `message.user.username`, so we gate click behavior on a known set.
  agentAuthorKeys?: Set<string>;
  // Clicking the author avatar / name opens the inspector to that member's
  // detail sub-page. Passed in by V2Thread; only fires for agent authors.
  onAuthorClick?: (author: string) => void;
  /**
   * The root this bubble is being rendered UNDER, when it sits inside an
   * expanded thread rail. Undefined everywhere else, including for the same
   * message rendered flat in the channel.
   *
   * Only used to suppress a quote that would restate the context the rail
   * already provides — see the predicate at the quote block. Deliberately not
   * a boolean like `inThread`: the suppression has to compare the quote's
   * target to THIS root, and a boolean cannot express "the right root".
   */
  insideThreadRoot?: string;
  // Clicking a file pill routes to the inspector artifact preview by
  // ObjectStore filename (or originalName for static demo tokens).
  onOpenFile?: (fileName: string) => void;
  // Sets this message as the composer's reply target (reply threading —
  // backend replyToMessageId; agents already use it, this is the human side).
  onReply?: (message: V2Message) => void;
  // Starts or joins the message's thread without creating a reply edge. The
  // parent resolves an already-threaded message to its existing root before
  // aiming the composer, so this control never asks the server for nesting.
  onThread?: (message: V2Message) => void;
  // Consecutive-author grouping (craft audit finding 7): when the previous
  // message is the same author within the grouping window, the header row
  // (avatar / name / time) is suppressed and the row tightens. The avatar
  // column is kept as an empty grid cell so text stays aligned. Reply moves
  // to a hover affordance since the head row is gone.
  grouped?: boolean;
}

interface ParsedFile {
  name: string;
  ext: string;
  size?: string;
  // Set when the pill came from an [[upload:...]] directive backed by a real
  // ObjectStore record. Click → mint signed URL → open. Plain [[file:...]]
  // pills (used by demo fixtures) leave this undefined and render as static.
  fileName?: string;
}

interface ParsedReaction {
  emoji: string;
  count: number;
}

const FILE_EXT_COLORS: Record<string, string> = {
  md: '#60a5fa',
  txt: '#94a3b8',
  pdf: '#ef4444',
  docx: '#3b82f6',
  doc: '#3b82f6',
  xlsx: '#10b981',
  xls: '#10b981',
  csv: '#10b981',
  pptx: '#f97316',
  ppt: '#f97316',
  odt: '#3b82f6',
  ods: '#10b981',
  odp: '#f97316',
  json: '#f59e0b',
  zip: '#a78bfa',
  png: '#f472b6',
  jpg: '#f472b6',
  jpeg: '#f472b6',
};

// Match a markdown-ish file token: [[file:Name.ext]] or [[file:Name.ext|2.4 KB]].
// This is a v2-only convention so we can preview file pills until the backend
// Message model gains a real `attachments[]` field.
const FILE_TOKEN_RE = /\[\[file:([^\]|]+)(?:\|([^\]]+))?\]\]/g;
// Match a real upload directive emitted by the composer / agent SDK after a
// successful POST /api/uploads:
//   [[upload:<fileName>|<originalName>|<size>|<kind>]]
// fileName is the ObjectStore key (e.g. `1714678910-712345678.pdf`); the pill
// click handler exchanges it for a short-TTL signed URL via getSignedAttachmentUrl.
const UPLOAD_TOKEN_RE = /\[\[upload:([^\]|]+)\|([^\]|]+)\|([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const formatBytes = (raw: string | number): string => {
  const n = typeof raw === 'number' ? raw : parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
};
// Match a v2 reactions token: [[reactions:👍 3, 💬 2, 🔥 1]]. Pure render —
// no write path tonight; the YC demo seed populates this from fixtures.
// Real reactions backend ships post-YC.
const REACTION_TOKEN_RE = /\[\[reactions:([^\]]+)\]\]/g;
const MARKDOWN_IMAGE_RE = /^!\[[^\]]*\]\(([^)]+)\)$/;
const IMAGE_URL_RE = /^https?:\/\/.+\.(png|jpe?g|gif|webp)(\?.*)?$/i;

const parseFiles = (content: string): { stripped: string; files: ParsedFile[] } => {
  const files: ParsedFile[] = [];
  // Real uploads first — they carry a fileName and resolve to a signed URL on
  // click. Then static file tokens (demo fixtures, no backend reference).
  let working = content.replace(UPLOAD_TOKEN_RE, (_match, rawFileName, rawOriginal, rawSize) => {
    const fileName = String(rawFileName).trim();
    const name = String(rawOriginal).trim();
    const dot = name.lastIndexOf('.');
    const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : 'file';
    files.push({ fileName, name, ext, size: formatBytes(String(rawSize).trim()) || undefined });
    return '';
  });
  working = working.replace(FILE_TOKEN_RE, (_match, rawName, rawSize) => {
    const name = String(rawName).trim();
    const dot = name.lastIndexOf('.');
    const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : 'file';
    files.push({ name, ext, size: rawSize ? String(rawSize).trim() : undefined });
    return '';
  });
  return { stripped: working.trim(), files };
};

const parseReactions = (content: string): { stripped: string; reactions: ParsedReaction[] } => {
  const reactions: ParsedReaction[] = [];
  const stripped = content.replace(REACTION_TOKEN_RE, (_match, body) => {
    String(body).split(',').forEach((entry: string) => {
      const trimmed = entry.trim();
      if (!trimmed) return;
      // Accept "👍 3" or "👍3" — count is the trailing digits, emoji is the rest.
      const m = trimmed.match(/^(.*?)\s*(\d+)$/u);
      if (!m) return;
      const emoji = m[1].trim();
      const count = parseInt(m[2], 10);
      if (emoji && Number.isFinite(count) && count > 0) {
        reactions.push({ emoji, count });
      }
    });
    return '';
  }).trim();
  return { stripped, reactions };
};

const FilePill: React.FC<{
  file: ParsedFile;
  onOpenFile?: (fileName: string) => void;
}> = ({ file, onOpenFile }) => {
  const color = FILE_EXT_COLORS[file.ext] || '#94a3b8';
  const inner = (
    <>
      <span className="v2-msg__file-icon" style={{ background: color }}>
        {file.ext.slice(0, 4).toUpperCase()}
      </span>
      <span className="v2-msg__file-meta">
        <span className="v2-msg__file-name">{file.name}</span>
        {file.size && <span className="v2-msg__file-size">{file.size}</span>}
      </span>
    </>
  );
  // Static demo file with no backend reference — but we can still try to
  // resolve it via the inspector's pod-files index by `originalName`. The
  // inspector's `openByFileName` callback (threaded down from V2Layout) is
  // tolerant of either the ObjectStore key or a originalName lookup, so a
  // chat author can post a `[[file:foo.md]]` static token and clicking it
  // opens the corresponding pod-file artifact preview if a file with that
  // originalName exists. Falls back to a non-clickable pill if there's no
  // handler in scope.
  if (!file.fileName) {
    if (onOpenFile) {
      const handleStaticClick = (e: React.MouseEvent) => {
        e.preventDefault();
        onOpenFile(file.name); // resolved by originalName
      };
      return (
        <button
          type="button"
          className="v2-msg__file v2-msg__file--clickable"
          onClick={handleStaticClick}
          aria-label={`Open ${file.name}`}
        >
          {inner}
        </button>
      );
    }
    return <span className="v2-msg__file">{inner}</span>;
  }
  // Real upload — prefer the inspector route when a handler is in scope so
  // the preview lands inline (markdown rendered, csv tabular, etc.) instead
  // of dumping raw bytes into a new tab. Fall back to the legacy signed-URL
  // open-in-tab when no handler is provided (older surfaces).
  const handleClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (onOpenFile && file.fileName) {
      onOpenFile(file.fileName);
      return;
    }
    const signed = await getSignedAttachmentUrl(`/api/uploads/${file.fileName}`);
    if (signed) {
      window.open(signed, '_blank', 'noopener,noreferrer');
    }
  };
  return (
    <button
      type="button"
      className="v2-msg__file v2-msg__file--clickable"
      onClick={handleClick}
      aria-label={`Open ${file.name}`}
    >
      {inner}
    </button>
  );
};

// Match the §3.8 agent-dm-created announcement posted by commonly-bot:
//   "🤝 Pixel and codex started a DM — [view](/v2/pods/<id>)"
// The full message body is the line above; capture the headline text and the
// target pod id so we can render a card with a router-aware navigation
// button instead of the raw markdown link (which would `target="_blank"` and
// pop a new tab — wrong for in-app navigation).
const AGENT_DM_EVENT_RE = /^🤝\s+(.+?)\s+—\s+\[view\]\(\/v2\/pods\/([a-f0-9]{24})\)\s*$/i;

const parseAgentDmEvent = (content: string | undefined): { headline: string; targetPodId: string } | null => {
  if (!content) return null;
  const match = content.trim().match(AGENT_DM_EVENT_RE);
  if (!match) return null;
  return { headline: match[1], targetPodId: match[2] };
};

const V2MessageRow: React.FC<V2MessageRowProps> = ({ message, decision, onDecisionRuled, isDecisionRuling = false, isLead, agentDisplayNames, agentAuthorKeys, onAuthorClick, onOpenFile, onReply, onThread, grouped, insideThreadRoot }) => {
  const { currentUser } = useAuth();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const api = useV2Api();
  // Picker state per message. Open via "+ react"; close on first click
  // (no need for outside-click handling — the picker hides after action).
  const [pickerOpen, setPickerOpen] = useState(false);
  // Touch reveal (Sam, 2026-08-23): on hoverless devices the action cluster
  // must NOT sit on every message by default — that is chrome over content.
  // A tap on the message reveals it (CSS shows .v2-msg--reveal only inside
  // the hover:none media block); a second tap or the picker closing hides
  // it again. Desktop hover behavior is untouched — the class is inert
  // wherever hover exists.
  const [actionsRevealed, setActionsRevealed] = useState(false);
  const onBubbleTap = () => {
    if (typeof window !== 'undefined'
      && window.matchMedia
      && window.matchMedia('(hover: none)').matches) {
      setActionsRevealed((v) => {
        if (v) setPickerOpen(false);
        return !v;
      });
    }
  };
  // Surface why a reaction failed instead of swallowing it. Before this, a
  // rejected reaction (bad emoji 400, non-member 403, rate-limit 429) did
  // nothing visible — which made the ❤️-validation bug read as "reactions
  // don't work / can't add more than one" (2026-07-24).
  const [reactionError, setReactionError] = useState<string | null>(null);
  const rawUsername = message.user?.username || 'Unknown';
  const overriddenDisplay = agentDisplayNames?.get(rawUsername);
  const author = overriddenDisplay || rawUsername;
  // Click is gated by agentAuthorKeys — backend may serve either raw username
  // or displayName on `message.user.username`, and the v2 set covers both.
  const isClickable = !!onAuthorClick && !!agentAuthorKeys?.has(rawUsername.toLowerCase());
  const handleAuthorClick = isClickable ? () => onAuthorClick?.(rawUsername) : undefined;
  const time = formatRelativeTime(message.created_at);

  if (decision) {
    return (
      <div className="v2-message-row v2-message-row--decision">
        <V2DecisionCard
          decision={{ ...decision, actorName: decision.actorName || author }}
          onRuled={onDecisionRuled}
        />
      </div>
    );
  }

  // ADR-020 D3: payload-driven components render from structure, not
  // content regex — the first message class where `payload` is the truth
  // and `content` is only the plain-text fallback for legacy surfaces.
  if (message.payload?.kind === 'approval-card') {
    return <V2ApprovalCard message={message} authorLabel={author} time={time} />;
  }

  // §3.8 system event card. Detected by content shape (commonly-bot only
  // posts this exact form), so we don't depend on a metadata column the PG
  // messages table doesn't have. Render a chrome-light card with a
  // router-aware "Open conversation" button — never a new tab.
  const dmEvent = parseAgentDmEvent(message.content);
  if (dmEvent) {
    return (
      <div className="v2-msg v2-msg--system">
        <div className="v2-syscard v2-syscard--action">
          <div className="v2-syscard__icon" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 00-3-3.87" />
              <path d="M16 3.13a4 4 0 010 7.75" />
            </svg>
          </div>
          <div className="v2-syscard__body">
            <div className="v2-syscard__headline">{dmEvent.headline}</div>
            {time && <div className="v2-syscard__time">{time}</div>}
          </div>
          <button
            type="button"
            className="v2-syscard__cta"
            onClick={() => navigate(`/v2/pods/${dmEvent.targetPodId}`)}
          >
            Open conversation
          </button>
        </div>
      </div>
    );
  }

  // Two-pass parse: reactions first (they live anywhere in the body), then
  // files. Order matters — files leave a trimmed body that we then read for
  // image rendering.
  const { stripped: noReactions, reactions } = parseReactions(message.content || '');
  const { stripped: afterFiles, files } = parseFiles(noReactions);
  const markdownImage = afterFiles.match(MARKDOWN_IMAGE_RE)?.[1];
  const rawImageUrl = message.message_type === 'image' || message.messageType === 'image' || IMAGE_URL_RE.test(afterFiles)
    ? afterFiles
    : markdownImage;
  // Upload responses use instance-portable `/api/uploads/...` references.
  // Resolve them against the configured API origin at render time so the
  // browser never requests image bytes from the frontend host.
  const imageUrl = rawImageUrl ? normalizeUploadUrl(rawImageUrl) : undefined;

  // GitHub PR URL detection — if the message body contains a `pull/<n>` URL,
  // we render an inline preview card below the text. Card fetch is lazy +
  // memoized at module scope; one fetch per (owner, repo, number) per session.
  // The bare URL is stripped from the rendered text so we don't double-show
  // "URL as text + URL as card".
  const prRefs = imageUrl ? [] : parseGithubPrUrls(afterFiles);
  let stripped = afterFiles;
  if (prRefs.length > 0) {
    stripped = afterFiles.replace(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+(?=\b|$)/g, '').trim();
  }
  // Auto-linkify bare http(s) URLs that aren't already inside markdown link
  // syntax. Without this, agents posting raw URLs render as plain text and
  // the user can't click them.
  if (stripped) {
    stripped = stripped.replace(
      /(?<![(<[])(https?:\/\/[^\s<>"]+?[^\s<>".,!?;:])(?=[\s.,!?;:]|$)/g,
      '[$1]($1)',
    );
  }

  // Highlight messages that @-mention the current user. Word-boundary so
  // `@foo` doesn't match `@foobar`. Skip for self-authored messages — no
  // value highlighting your own outgoing message.
  const meUsername = currentUser?.username?.toLowerCase();
  const isSelfAuthored = meUsername === rawUsername.toLowerCase();
  const mentionsMe = !isSelfAuthored
    && !!meUsername
    && new RegExp(`@${meUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(stripped);

  // --- reactions state, hoisted from the render tail so the hover cluster
  // owns the trigger while the chips row keeps rendering below the text ---
  const liveReactions = message.reactions;
  const hasLive = Array.isArray(liveReactions);
  const reactMessageId = String(message.id || '');
  const canInteract = !!(hasLive && reactMessageId && /^\d+$/.test(reactMessageId));
  const renderList: V2RenderedReaction[] = hasLive
    ? liveReactions!
    : reactions.map((r) => ({ emoji: r.emoji, count: r.count, mine: false }));
  const toggleReaction = async (emoji: string, mine: boolean) => {
    if (!canInteract) return;
    try {
      if (mine) {
        await api.del(`/api/messages/${reactMessageId}/reactions/${encodeURIComponent(emoji)}`);
      } else {
        await api.post(`/api/messages/${reactMessageId}/reactions`, { emoji });
      }
      // Optimistic update is unnecessary — the socket `messageReaction`
      // event from the backend updates the message list in place.
    } catch (err) {
      const e = err as { response?: { status?: number; data?: { msg?: string; error?: string } } };
      const status = e.response?.status;
      const serverMsg = e.response?.data?.msg || e.response?.data?.error;
      setReactionError(
        serverMsg
        || (status === 403 ? "You're not a member of this pod." : '')
        || (status === 429 ? 'Too many reactions — give it a moment.' : '')
        || 'Could not add that reaction.',
      );
      window.setTimeout(() => setReactionError(null), 4000);
      // eslint-disable-next-line no-console
      console.warn('[reactions] toggle failed:', (err as Error).message);
    } finally {
      setPickerOpen(false);
    }
  };

  return (
    <div
      data-testid={isDecisionRuling ? 'decision-ruling-row' : undefined}
      className={`v2-msg v2-message-row${mentionsMe ? ' v2-msg--mention' : ''}${grouped ? ' v2-msg--grouped' : ''}${actionsRevealed ? ' v2-msg--reveal' : ''}`}
      onClick={onBubbleTap}
    >
      {grouped ? (
        <div className="v2-msg__avatar-ghost" aria-hidden="true" />
      ) : isClickable ? (
        <button
          type="button"
          className="v2-msg__avatar-btn"
          onClick={handleAuthorClick}
          aria-label={`Open ${author} details`}
        >
          <V2Avatar
            name={author}
            src={message.user?.profile_picture || undefined}
            size={insideThreadRoot ? 'sm' : 'md'}
            kind={typeof message.user?.isBot === 'boolean' ? (message.user.isBot ? 'agent' : 'human') : undefined}
            seed={message.user_id || undefined}
          />
        </button>
      ) : (
        <V2Avatar
          name={author}
          src={message.user?.profile_picture || undefined}
          size={insideThreadRoot ? 'sm' : 'md'}
          kind={typeof message.user?.isBot === 'boolean' ? (message.user.isBot ? 'agent' : 'human') : undefined}
          seed={message.user_id || undefined}
        />
      )}
      <V2MessageActions
        message={message}
        author={author}
        onReply={onReply}
        onThread={onThread}
        canInteract={canInteract}
        pickerOpen={pickerOpen}
        reactions={renderList}
        onTogglePicker={() => setPickerOpen((open) => !open)}
        onToggleReaction={toggleReaction}
      />
      <div className="v2-msg__body">
        {!grouped && (
        <div className="v2-msg__head">
          {isClickable ? (
            <button type="button" className="v2-msg__author-btn" onClick={handleAuthorClick}>
              {author}
            </button>
          ) : (
            <span className="v2-msg__author">{author}</span>
          )}
          {isLead && <span className="v2-msg__lead-badge">{t('podChat.leadBadge')}</span>}
          {time && <span className="v2-msg__time">{time}</span>}
          {isDecisionRuling && <span className="v2-msg__ruled">· {t('activity.decision.ruledShort')}</span>}
        </div>
        )}
        {(() => {
          // Quoted context for replies. POST responses carry a normalized
          // `replyTo` object; list rows may carry raw reply_* columns instead.
          const rawQuote = message.replyTo?.content ?? message.reply_content;
          // Collapse upload directives to a paperclip+name — same treatment as
          // the sidebar preview and the composer reply chip.
          const quoteContent = rawQuote
            ? String(rawQuote).replace(/\[\[upload:[^\]|]+\|([^\]|]+)\|[^\]]+\]\]/g, '📎 $1')
            : rawQuote;
          const quoteAuthor = message.replyTo?.username ?? message.reply_username;
          if (!quoteContent) return null;

          // Suppress the quote IFF it points at the root of the rail we are
          // already inside (Sam 57491, ruling constraint 5). Both halves are
          // required and neither is sufficient:
          //
          //   - inside a rail, quoting SOMEONE ELSE in the thread  -> show.
          //     That is a reply-to-person and the quote is the only thing
          //     naming who.
          //   - quoting the root but rendered FLAT in the channel   -> show.
          //     There is no rail supplying the context, so removing the quote
          //     would strand the reply.
          //
          // The failure mode of getting this wrong is asymmetric: showing a
          // redundant quote is visual noise, hiding a needed one loses the
          // only pointer to what a message answers.
          const quoteTargetId = message.replyTo?.id ?? message.reply_msg_id;
          const quotesTheRailRoot = insideThreadRoot !== undefined
            && quoteTargetId !== undefined
            && quoteTargetId !== null
            && String(quoteTargetId) === String(insideThreadRoot);
          if (quotesTheRailRoot) return null;
          return (
            <div className="v2-msg__quote">
              <span className="v2-msg__quote-author">{quoteAuthor || 'earlier message'}</span>
              <span className="v2-msg__quote-text">{String(quoteContent).slice(0, 140)}</span>
            </div>
          );
        })()}
        {imageUrl ? (
          <a href={imageUrl} target="_blank" rel="noreferrer" className="v2-msg__image-link">
            <img src={imageUrl} alt="Uploaded attachment" className="v2-msg__image" />
          </a>
        ) : (
          stripped && (
            <div className="v2-msg__content">
              <ReactMarkdown components={messageMarkdownComponents}>{stripped}</ReactMarkdown>
            </div>
          )
        )}
        {files.map((file, idx) => (
          <FilePill key={`${file.name}-${idx}`} file={file} onOpenFile={onOpenFile} />
        ))}
        {prRefs.map((pr) => (
          <V2GithubPrCard
            key={`${pr.owner}/${pr.repo}#${pr.number}`}
            owner={pr.owner}
            repo={pr.repo}
            number={pr.number}
          />
        ))}
        {(() => {
          // Sprint B5: real reactions come from message.reactions (server-
          // aggregated `[{emoji, count, mine}]`); legacy fixtures use the
          // token-parsed list. Both are hoisted above as `renderList` so the
          // hover cluster shares the trigger. This row now renders ONLY when
          // there are chips (or a transient error) to show — the trigger
          // lives in the cluster, so the empty "bare band" state no longer
          // exists at all rather than being collapsed by CSS.
          if (renderList.length === 0 && !reactionError) return null;

          // Google-Chat-style attribution: build a names-line for the
          // reaction-chip tooltip from the decorated `users` array when
          // the backend includes it (reactionAttributionService). Falls
          // back to count-only on older servers / fixtures.
          const formatReactionTitle = (r: typeof renderList[number]): string => {
            const live = r as { users?: Array<{ username: string; displayName?: string }> };
            const users = Array.isArray(live.users) ? live.users : [];
            if (!users.length) {
              return `${r.count} ${r.emoji}${r.mine ? ' (you)' : ''}`;
            }
            const names = users.map((u) => u.displayName || u.username);
            // Caller's user ID isn't threaded down here; rather than
            // guessing which entry in `users` is the caller, append a
            // single "(you)" suffix to the whole line when r.mine —
            // matches Google Chat's behavior on its own reaction
            // tooltips and avoids mis-labelling an arbitrary entry.
            return `${names.join(', ')} reacted with ${r.emoji}${r.mine ? ' (you)' : ''}`;
          };

          return (
            <div className="v2-msg__reactions" aria-label="Reactions">
              {renderList.map((r, idx) => (
                <button
                  key={`${r.emoji}-${idx}`}
                  type="button"
                  className={`v2-msg__reaction${r.mine ? ' v2-msg__reaction--mine' : ''}`}
                  title={formatReactionTitle(r)}
                  onClick={() => toggleReaction(r.emoji, !!r.mine)}
                  disabled={!canInteract}
                >
                  <span className="v2-msg__reaction-emoji">{r.emoji}</span>
                  <span className="v2-msg__reaction-count">{r.count}</span>
                </button>
              ))}
              {reactionError && (
                <span className="v2-msg__reaction-error" role="alert">{reactionError}</span>
              )}
            </div>
          );
        })()}
      </div>
    </div>
  );
};

export default V2MessageRow;
