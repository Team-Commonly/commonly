import React from 'react';
import V2Avatar from './V2Avatar';
import { V2Message } from '../hooks/useV2PodDetail';
import { formatRelativeTime } from '../utils/grouping';

interface V2MessageBubbleProps {
  message: V2Message;
  isLead?: boolean;
}

interface ParsedFile {
  name: string;
  ext: string;
  size?: string;
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
// Match a v2 reactions token: [[reactions:👍 3, 💬 2, 🔥 1]]. Pure render —
// no write path tonight; the YC demo seed populates this from fixtures.
// Real reactions backend ships post-YC.
const REACTION_TOKEN_RE = /\[\[reactions:([^\]]+)\]\]/g;
const MARKDOWN_IMAGE_RE = /^!\[[^\]]*\]\(([^)]+)\)$/;
const IMAGE_URL_RE = /^https?:\/\/.+\.(png|jpe?g|gif|webp)(\?.*)?$/i;

const parseFiles = (content: string): { stripped: string; files: ParsedFile[] } => {
  const files: ParsedFile[] = [];
  const stripped = content.replace(FILE_TOKEN_RE, (_match, rawName, rawSize) => {
    const name = String(rawName).trim();
    const dot = name.lastIndexOf('.');
    const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : 'file';
    files.push({ name, ext, size: rawSize ? String(rawSize).trim() : undefined });
    return '';
  }).trim();
  return { stripped, files };
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
  return (
    <span className="v2-msg__file">
      <span className="v2-msg__file-icon" style={{ background: color }}>
        {file.ext.slice(0, 4).toUpperCase()}
      </span>
      <span className="v2-msg__file-meta">
        <span className="v2-msg__file-name">{file.name}</span>
        {file.size && <span className="v2-msg__file-size">{file.size}</span>}
      </span>
    </span>
  );
};

const V2MessageBubble: React.FC<V2MessageBubbleProps> = ({ message, isLead }) => {
  const author = message.user?.username || 'Unknown';
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

  return (
    <div className="v2-msg">
      <V2Avatar
        name={author}
        src={message.user?.profile_picture || undefined}
        size="md"
      />
      <div className="v2-msg__body">
        <div className="v2-msg__head">
          <span className="v2-msg__author">{author}</span>
          {isLead && <span className="v2-msg__lead-badge">Lead</span>}
          {time && <span className="v2-msg__time">{time}</span>}
        </div>
        {imageUrl ? (
          <a href={imageUrl} target="_blank" rel="noreferrer" className="v2-msg__image-link">
            <img src={imageUrl} alt="Uploaded attachment" className="v2-msg__image" />
          </a>
        ) : (
          stripped && <div className="v2-msg__content">{stripped}</div>
        )}
        {files.map((file, idx) => (
          <FilePill key={`${file.name}-${idx}`} file={file} />
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
