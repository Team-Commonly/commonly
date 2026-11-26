import React, { createContext, useContext } from 'react';
import type { MentionLabels } from '../utils/mentionLabels';

// Match @username — letters/digits start, then letters/digits/underscore/hyphen.
// The capturing group keeps the match in `split()` output so text and chip
// segments render in order. An npm scope such as @commonlyai/mcp is a package,
// not a person.
export const MENTION_RE = /(?<![a-zA-Z0-9_.+-])(@[a-zA-Z0-9][a-zA-Z0-9_-]*)(?![a-zA-Z0-9_-]|\/[a-zA-Z0-9])/g;

const EMPTY: MentionLabels = new Map();

/** Lowercase handle → the name people read, for the pod being shown (F645). */
export const MentionLabelsContext = createContext<MentionLabels>(EMPTY);

export const useMentionLabels = (): MentionLabels => useContext(MentionLabelsContext);

/**
 * One `@handle` in a message. A handle the pod knows reads as its display name
 * (`@Claude Code`), with the handle kept in the tooltip; the stored text stays
 * the handle, so mention routing never changes. An unknown handle stays as written.
 */
export const V2MentionChip: React.FC<{ token: string }> = ({ token }) => {
  const labels = useMentionLabels();
  const handle = token.replace(/^@/, '');
  const label = labels.get(handle.toLowerCase());
  if (!label || label.toLowerCase() === handle.toLowerCase()) {
    return <span className="v2-msg__mention">{token}</span>;
  }
  return <span className="v2-msg__mention" title={token} data-handle={handle}>@{label}</span>;
};

// Walk a React children tree and replace bare `@name` text segments with a
// chip. Recurses into arrays + cloned elements so mentions inside `<strong>`,
// `<em>`, list items, etc. still render. Code blocks (`<code>`, `<pre>`) are
// skipped: code is verbatim, and a mention in code is intentional.
export const renderWithMentions = (node: React.ReactNode): React.ReactNode => {
  if (typeof node === 'string') {
    if (!node.includes('@')) return node;
    const parts = node.split(MENTION_RE);
    return parts.map((part, i) => {
      if (i % 2 === 1) {
        return <V2MentionChip key={i} token={part} />;
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

/**
 * Plain text (not markdown) with chips, for a surface such as the decision
 * card's question. A backticked span stays verbatim and unchipped, as it does
 * in a message body: backtick a handle to mention it without addressing it.
 */
export const renderPlainWithMentions = (text: string): React.ReactNode => (
  text.split(/(`[^`\n]+`)/).map((part, i) => (
    <React.Fragment key={i}>{i % 2 === 1 ? part : renderWithMentions(part)}</React.Fragment>
  ))
);
