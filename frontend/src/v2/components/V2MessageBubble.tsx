import React from 'react';
import { useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import V2Avatar from './V2Avatar';
import V2GithubPrCard, { parseGithubPrUrls } from './V2GithubPrCard';
import { V2Message } from '../hooks/useV2PodDetail';
import { formatRelativeTime } from '../utils/grouping';
import { useAuth } from '../../context/AuthContext';
import { getSignedAttachmentUrl } from '../../utils/signedAttachmentUrl';

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

interface V2MessageBubbleProps {
  message: V2Message;
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
  // detail sub-page. Passed in by V2PodChat; only fires for agent authors.
  onAuthorClick?: (author: string) => void;
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

const FilePill: React.FC<{ file: ParsedFile }> = ({ file }) => {
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
  // Static demo file (no backend reference) — render as a div, no click.
  if (!file.fileName) {
    return <span className="v2-msg__file">{inner}</span>;
  }
  // Real upload — mint signed URL on click. Don't fetch eagerly: a chat with
  // 50 file messages would mint 50 tokens on render. Mint on demand keeps the
  // 30/min/user rate limit comfortable.
  const handleClick = async (e: React.MouseEvent) => {
    e.preventDefault();
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

const V2MessageBubble: React.FC<V2MessageBubbleProps> = ({ message, isLead, agentDisplayNames, agentAuthorKeys, onAuthorClick }) => {
  const { currentUser } = useAuth();
  const navigate = useNavigate();
  const rawUsername = message.user?.username || 'Unknown';
  const overriddenDisplay = agentDisplayNames?.get(rawUsername);
  const author = overriddenDisplay || rawUsername;
  // Click is gated by agentAuthorKeys — backend may serve either raw username
  // or displayName on `message.user.username`, and the v2 set covers both.
  const isClickable = !!onAuthorClick && !!agentAuthorKeys?.has(rawUsername.toLowerCase());
  const handleAuthorClick = isClickable ? () => onAuthorClick?.(rawUsername) : undefined;
  const time = formatRelativeTime(message.created_at);

  // §3.8 system event card. Detected by content shape (commonly-bot only
  // posts this exact form), so we don't depend on a metadata column the PG
  // messages table doesn't have. Render a chrome-light card with a
  // router-aware "Open conversation" button — never a new tab.
  const dmEvent = parseAgentDmEvent(message.content);
  if (dmEvent) {
    return (
      <div className="v2-msg v2-msg--system">
        <div className="v2-syscard">
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
  const imageUrl = message.message_type === 'image' || message.messageType === 'image' || IMAGE_URL_RE.test(afterFiles)
    ? afterFiles
    : markdownImage;

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

  return (
    <div className={`v2-msg${mentionsMe ? ' v2-msg--mention' : ''}`}>
      {isClickable ? (
        <button
          type="button"
          className="v2-msg__avatar-btn"
          onClick={handleAuthorClick}
          aria-label={`Open ${author} details`}
        >
          <V2Avatar
            name={author}
            src={message.user?.profile_picture || undefined}
            size="md"
          />
        </button>
      ) : (
        <V2Avatar
          name={author}
          src={message.user?.profile_picture || undefined}
          size="md"
        />
      )}
      <div className="v2-msg__body">
        <div className="v2-msg__head">
          {isClickable ? (
            <button type="button" className="v2-msg__author-btn" onClick={handleAuthorClick}>
              {author}
            </button>
          ) : (
            <span className="v2-msg__author">{author}</span>
          )}
          {isLead && <span className="v2-msg__lead-badge">Lead</span>}
          {time && <span className="v2-msg__time">{time}</span>}
        </div>
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
          <FilePill key={`${file.name}-${idx}`} file={file} />
        ))}
        {prRefs.map((pr) => (
          <V2GithubPrCard
            key={`${pr.owner}/${pr.repo}#${pr.number}`}
            owner={pr.owner}
            repo={pr.repo}
            number={pr.number}
          />
        ))}
        {reactions.length > 0 && (
          <div className="v2-msg__reactions" aria-label="Reactions">
            {reactions.map((r, idx) => (
              <span key={`${r.emoji}-${idx}`} className="v2-msg__reaction" title={`${r.count} ${r.emoji}`}>
                <span className="v2-msg__reaction-emoji">{r.emoji}</span>
                <span className="v2-msg__reaction-count">{r.count}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default V2MessageBubble;
