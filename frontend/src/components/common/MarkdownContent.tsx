import React from 'react';
import ReactMarkdown from 'react-markdown';
import { Box, Typography } from '@mui/material';

const HASHTAG_RE = /(#\w+)/g;

function renderWithHashtags(
  text: React.ReactNode,
  onHashtagClick: (tag: string) => void,
): React.ReactNode {
  if (typeof text !== 'string') return text;
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
          onClick={(e: React.MouseEvent) => {
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

function childrenToText(children: React.ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(childrenToText).join('');
  if (React.isValidElement(children)) {
    return childrenToText((children.props as { children?: React.ReactNode }).children);
  }
  return '';
}

interface MarkdownContentProps {
  children?: string | null;
  variant?: 'chat' | 'post' | 'comment';
  onHashtagClick?: (tag: string) => void;
}

export default function MarkdownContent({
  children,
  variant = 'post',
  onHashtagClick,
}: MarkdownContentProps): React.ReactElement | null {
  if (!children) return null;

  const isChat = variant === 'chat';
  const paragraphMargin = isChat ? 0 : 0.5;

  // Using Record<string, unknown> for component props since react-markdown v10
  // types vary by component key and we only need runtime behaviour here.
  const components: Record<string, React.ComponentType<Record<string, unknown>>> = {
    p({ children: pChildren }) {
      const content = onHashtagClick
        ? renderWithHashtags(childrenToText(pChildren as React.ReactNode), onHashtagClick)
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
          {content as React.ReactNode}
        </Box>
      );
    },

    a({ href, children: aChildren }) {
      return (
        <Box
          component="a"
          href={href as string | undefined}
          target="_blank"
          rel="noopener noreferrer"
          sx={{ color: 'primary.main', textDecoration: 'underline' }}
        >
          {aChildren as React.ReactNode}
        </Box>
      );
    },

    code({ inline, children: cChildren }) {
      if ((inline as boolean | undefined) !== false) {
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
            {cChildren as React.ReactNode}
          </Box>
        );
      }
      return (
        <Box
          component="code"
          sx={{ fontFamily: 'monospace', fontSize: '0.875em', display: 'block', whiteSpace: 'pre' }}
        >
          {cChildren as React.ReactNode}
        </Box>
      );
    },

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
          {preChildren as React.ReactNode}
        </Box>
      );
    },

    ul({ children: ulChildren }) {
      return (
        <Box component="ul" sx={{ pl: 2.5, my: paragraphMargin }}>
          {ulChildren as React.ReactNode}
        </Box>
      );
    },
    ol({ children: olChildren }) {
      return (
        <Box component="ol" sx={{ pl: 2.5, my: paragraphMargin }}>
          {olChildren as React.ReactNode}
        </Box>
      );
    },
    li({ children: liChildren }) {
      return <Box component="li" sx={{ mb: 0.25 }}>{liChildren as React.ReactNode}</Box>;
    },

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
          {bqChildren as React.ReactNode}
        </Box>
      );
    },

    h1({ children: hChildren }) {
      return (
        <Typography variant="subtitle1" sx={{ fontWeight: 700, mt: 1, mb: 0.5 }}>
          {hChildren as React.ReactNode}
        </Typography>
      );
    },
    h2({ children: hChildren }) {
      return (
        <Typography variant="subtitle2" sx={{ fontWeight: 700, mt: 1, mb: 0.5 }}>
          {hChildren as React.ReactNode}
        </Typography>
      );
    },
    h3({ children: hChildren }) {
      return (
        <Typography variant="body2" sx={{ fontWeight: 700, mt: 0.5, mb: 0.25 }}>
          {hChildren as React.ReactNode}
        </Typography>
      );
    },

    hr() {
      return (
        <Box
          component="hr"
          sx={{ border: 'none', borderTop: '1px solid', borderColor: 'divider', my: 1 }}
        />
      );
    },

    strong({ children: sChildren }) {
      return <Box component="strong" sx={{ fontWeight: 700 }}>{sChildren as React.ReactNode}</Box>;
    },
    em({ children: eChildren }) {
      return <Box component="em" sx={{ fontStyle: 'italic' }}>{eChildren as React.ReactNode}</Box>;
    },
  };

  return (
    <Box sx={{ '& > *:first-child': { mt: 0 }, '& > *:last-child': { mb: 0 } }}>
      <ReactMarkdown components={components as Parameters<typeof ReactMarkdown>[0]['components']}>
        {children}
      </ReactMarkdown>
    </Box>
  );
}
