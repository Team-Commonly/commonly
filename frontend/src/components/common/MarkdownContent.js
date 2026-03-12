import React from 'react';
import ReactMarkdown from 'react-markdown';
import { Box, Typography } from '@mui/material';

const HASHTAG_RE = /(#\w+)/g;

/**
 * Splits a string by hashtags and returns an array of strings and clickable spans.
 */
function renderWithHashtags(text, onHashtagClick) {
  if (!onHashtagClick || typeof text !== 'string') return text;
  const parts = text.split(HASHTAG_RE);
  if (parts.length === 1) return text;
  return parts.map((part, i) => {
    if (part.startsWith('#')) {
      return (
        <Typography
          key={i}
          component="span"
          color="primary"
          sx={{ fontWeight: 'bold', cursor: 'pointer' }}
          onClick={(e) => {
            e.stopPropagation();
            onHashtagClick(part.substring(1));
          }}
          className="hashtag"
        >
          {part}
        </Typography>
      );
    }
    return part;
  });
}

/**
 * Recursively extracts plain text from React children for hashtag splitting.
 */
function childrenToText(children) {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(childrenToText).join('');
  if (React.isValidElement(children)) return childrenToText(children.props.children);
  return '';
}

/**
 * MarkdownContent — renders a markdown string with MUI-compatible styling.
 *
 * Props:
 *   children: string           — markdown source text
 *   variant: 'chat' | 'post' | 'comment'  (default: 'post')
 *   onHashtagClick: (tag) => void          — optional; enables hashtag highlighting
 */
export default function MarkdownContent({ children, variant = 'post', onHashtagClick }) {
  if (!children) return null;

  const isChat = variant === 'chat';
  const paragraphMargin = isChat ? 0 : 0.5;

  const components = {
    // Paragraphs — with optional hashtag highlighting
    p({ children: pChildren }) {
      const content = onHashtagClick
        ? renderWithHashtags(childrenToText(pChildren), onHashtagClick)
        : pChildren;
      return (
        <Box
          component="p"
          sx={{
            my: paragraphMargin,
            whiteSpace: 'pre-line',
            fontSize: isChat ? 'inherit' : undefined,
            lineHeight: isChat ? 'inherit' : 1.6,
          }}
        >
          {content}
        </Box>
      );
    },

    // Links
    a({ href, children: aChildren }) {
      return (
        <Box
          component="a"
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          sx={{ color: 'primary.main', textDecoration: 'underline' }}
        >
          {aChildren}
        </Box>
      );
    },

    // Inline code
    code({ inline, children: cChildren }) {
      if (inline !== false) {
        return (
          <Box
            component="code"
            sx={{
              fontFamily: 'monospace',
              fontSize: '0.875em',
              bgcolor: 'action.hover',
              px: 0.5,
              py: 0.25,
              borderRadius: 0.5,
            }}
          >
            {cChildren}
          </Box>
        );
      }
      return (
        <Box
          component="code"
          sx={{ fontFamily: 'monospace', fontSize: '0.875em', display: 'block', whiteSpace: 'pre' }}
        >
          {cChildren}
        </Box>
      );
    },

    // Code blocks
    pre({ children: preChildren }) {
      return (
        <Box
          component="pre"
          sx={{
            bgcolor: 'action.selected',
            borderRadius: 1,
            p: 1.5,
            my: 1,
            overflowX: 'auto',
            fontFamily: 'monospace',
            fontSize: '0.85em',
            lineHeight: 1.5,
            whiteSpace: 'pre',
            wordBreak: 'normal',
            overflowWrap: 'normal',
          }}
        >
          {preChildren}
        </Box>
      );
    },

    // Lists
    ul({ children: ulChildren }) {
      return (
        <Box component="ul" sx={{ pl: 2.5, my: paragraphMargin }}>
          {ulChildren}
        </Box>
      );
    },
    ol({ children: olChildren }) {
      return (
        <Box component="ol" sx={{ pl: 2.5, my: paragraphMargin }}>
          {olChildren}
        </Box>
      );
    },
    li({ children: liChildren }) {
      return <Box component="li" sx={{ mb: 0.25 }}>{liChildren}</Box>;
    },

    // Blockquotes
    blockquote({ children: bqChildren }) {
      return (
        <Box
          component="blockquote"
          sx={{
            borderLeft: '3px solid',
            borderColor: 'divider',
            pl: 1.5,
            my: 1,
            color: 'text.secondary',
            fontStyle: 'italic',
          }}
        >
          {bqChildren}
        </Box>
      );
    },

    // Headers — scaled down; agents shouldn't need page-size headings
    h1({ children: hChildren }) {
      return (
        <Typography variant="subtitle1" sx={{ fontWeight: 700, mt: 1, mb: 0.5 }}>
          {hChildren}
        </Typography>
      );
    },
    h2({ children: hChildren }) {
      return (
        <Typography variant="subtitle2" sx={{ fontWeight: 700, mt: 1, mb: 0.5 }}>
          {hChildren}
        </Typography>
      );
    },
    h3({ children: hChildren }) {
      return (
        <Typography variant="body2" sx={{ fontWeight: 700, mt: 0.5, mb: 0.25 }}>
          {hChildren}
        </Typography>
      );
    },

    // Horizontal rule
    hr() {
      return <Box component="hr" sx={{ border: 'none', borderTop: '1px solid', borderColor: 'divider', my: 1 }} />;
    },

    // Strong / em
    strong({ children: sChildren }) {
      return <Box component="strong" sx={{ fontWeight: 700 }}>{sChildren}</Box>;
    },
    em({ children: eChildren }) {
      return <Box component="em" sx={{ fontStyle: 'italic' }}>{eChildren}</Box>;
    },
  };

  return (
    <Box
      sx={{
        '& > *:first-child': { mt: 0 },
        '& > *:last-child': { mb: 0 },
      }}
    >
      <ReactMarkdown components={components}>
        {children}
      </ReactMarkdown>
    </Box>
  );
}
