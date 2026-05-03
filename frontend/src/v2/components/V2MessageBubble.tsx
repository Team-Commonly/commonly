import React from 'react';
import ReactMarkdown from 'react-markdown';
import V2Avatar from './V2Avatar';
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
  // Clicking a file pill opens the inspector to the artifact detail (where
  // preview + download live). When omitted, the pill falls back to opening
  // the bytes in a new tab via signed URL — works for users who haven't yet
  // upgraded to the inspector-aware flow but loses the preview-first UX.
  onArtifactClick?: (artifactId: string) => void;
}

interface ParsedFile {
  name: string;
  ext: string;
  size?: string;
  kind?: string;
  // Set when the pill came from an [[upload:...]] directive backed by a real
  // ObjectStore record. Click → open inspector artifact detail (or fall back
  // to a signed-URL new-tab if no inspector handle is wired). Plain
  // [[file:...]] pills (used by demo fixtures) leave both `fileName` and
  // `fileId` undefined and render as static.
  fileName?: string;
  fileId?: string;
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
// successful POST /api/uploads. Permissive bracket capture; the inner is
// split on `|` to support both the original 4-field shape and the new
// 5-field shape that adds the File _id (so click can open the inspector).
//   [[upload:<fileName>|<originalName>|<size>|<kind>]]                (legacy)
//   [[upload:<fileName>|<originalName>|<size>|<kind>|<fileId>]]      (current)
// fileName is the ObjectStore key (e.g. `1714678910-712345678.pdf`).
const UPLOAD_TOKEN_RE = /\[\[upload:([^\]]+)\]\]/g;
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
  // Real uploads first — they carry a fileName and (since 2026-05-03) a
  // fileId that lets click route through the inspector. Permissive split:
  // any extra fields beyond `fileId` are ignored, so future schema growth
  // doesn't break old-message render.
  let working = content.replace(UPLOAD_TOKEN_RE, (_match, rawInner) => {
    const parts = String(rawInner).split('|').map((p) => p.trim());
    const fileName = parts[0] || '';
    const name = parts[1] || fileName;
    const size = parts[2] || '';
    const kind = parts[3] || 'file';
    const fileId = parts[4] || undefined;
    if (!fileName) return '';
    const dot = name.lastIndexOf('.');
    const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : (kind || 'file');
    files.push({
      fileName,
      fileId,
      name,
      ext,
      kind,
      size: formatBytes(size) || undefined,
    });
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

// Human-readable file kind for the pill subline. Examples: PDF, Word doc,
// Excel sheet, JSON, Image. Falls through to the bare extension upper-cased
// when nothing matches — beats showing the raw `office` / `archive` / `data`
// classifier from the backend.
const KIND_LABELS: Record<string, string> = {
  pdf: 'PDF',
  doc: 'Word document',
  docx: 'Word document',
  xls: 'Excel spreadsheet',
  xlsx: 'Excel spreadsheet',
  ppt: 'PowerPoint',
  pptx: 'PowerPoint',
  odt: 'OpenDocument',
  ods: 'OpenDocument sheet',
  odp: 'OpenDocument slides',
  md: 'Markdown',
  txt: 'Text',
  csv: 'CSV',
  json: 'JSON',
  zip: 'Zip archive',
  png: 'PNG image',
  jpg: 'JPEG image',
  jpeg: 'JPEG image',
  gif: 'GIF',
  webp: 'WebP image',
  svg: 'SVG image',
};
const friendlyKindFor = (file: ParsedFile): string => (
  KIND_LABELS[file.ext] || file.ext.toUpperCase() || 'File'
);

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
  onArtifactClick?: (artifactId: string) => void;
}> = ({ file, onArtifactClick }) => {
  const color = FILE_EXT_COLORS[file.ext] || '#94a3b8';
  // Two-line layout matches Slack / Google Chat / Linear: filename owns the
  // visual weight, the kind + size sit below as muted metadata.
  const subline = [friendlyKindFor(file), file.size].filter(Boolean).join(' · ');
  const inner = (
    <>
      <span className="v2-msg__file-icon" style={{ background: color }}>
        {file.ext.slice(0, 4).toUpperCase()}
      </span>
      <span className="v2-msg__file-meta">
        <span className="v2-msg__file-name">{file.name}</span>
        {subline && <span className="v2-msg__file-sub">{subline}</span>}
      </span>
    </>
  );
  // Static demo file (no backend reference) — render as a div, no click.
  if (!file.fileName) {
    return <span className="v2-msg__file">{inner}</span>;
  }
  // Real upload — preferred path is to open the inspector to the artifact
  // detail (where preview + download live). When the host hasn't wired
  // `onArtifactClick` (or this is an old-format directive without a fileId),
  // fall back to minting a signed URL and opening in a new tab. Don't fetch
  // eagerly on render — a chat with 50 file messages would mint 50 tokens.
  const handleClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (onArtifactClick && file.fileId) {
      onArtifactClick(`file-${file.fileId}`);
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
      aria-label={`Preview ${file.name}`}
    >
      {inner}
    </button>
  );
};

const V2MessageBubble: React.FC<V2MessageBubbleProps> = ({ message, isLead, agentDisplayNames, agentAuthorKeys, onAuthorClick, onArtifactClick }) => {
  const { currentUser } = useAuth();
  const rawUsername = message.user?.username || 'Unknown';
  const overriddenDisplay = agentDisplayNames?.get(rawUsername);
  const author = overriddenDisplay || rawUsername;
  // Click is gated by agentAuthorKeys — backend may serve either raw username
  // or displayName on `message.user.username`, and the v2 set covers both.
  const isClickable = !!onAuthorClick && !!agentAuthorKeys?.has(rawUsername.toLowerCase());
  const handleAuthorClick = isClickable ? () => onAuthorClick?.(rawUsername) : undefined;
  const time = formatRelativeTime(message.created_at);
  // Two-pass parse: reactions first (they live anywhere in the body), then
  // files. Order matters — files leave a trimmed body that we then read for
  // image rendering.
  const { stripped: noReactions, reactions } = parseReactions(message.content || '');
  const { stripped, files } = parseFiles(noReactions);
  const markdownImage = stripped.match(MARKDOWN_IMAGE_RE)?.[1];
  const imageUrl = message.message_type === 'image' || message.messageType === 'image' || IMAGE_URL_RE.test(stripped)
    ? stripped
    : markdownImage;

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
          <FilePill key={`${file.name}-${idx}`} file={file} onArtifactClick={onArtifactClick} />
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
