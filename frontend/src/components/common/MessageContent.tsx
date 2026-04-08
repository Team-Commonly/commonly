import React, { useState } from 'react';
import {
  Box,
  Card,
  CardContent,
  Chip,
  Dialog,
  DialogContent,
  Link,
  Typography,
} from '@mui/material';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import MarkdownContent from './MarkdownContent';

const IMAGE_URL_RE = /https?:\/\/\S+\.(?:png|jpg|jpeg|gif|webp)(?:\?\S*)?/gi;
const TASK_COMPLETE_RE = /\b(TASK-\d{3,})\s+(?:completed?|done|finished|shipped|closed)/i;
const PR_RE = /\bPR\s*#(\d+)\b/i;
const BRANCH_RE = /(?:branch|branch:)\s*([a-zA-Z0-9_/.-]+)/i;

interface ImagePreviewProps {
  src: string;
}

function ImagePreview({ src }: ImagePreviewProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [errored, setErrored] = useState(false);

  if (errored) return <></>;
  return (
    <>
      <Box
        component="img"
        src={src}
        alt="Shared image"
        sx={{
          display: 'block',
          maxWidth: 400,
          maxHeight: 300,
          objectFit: 'cover',
          borderRadius: 1,
          mt: 1,
          cursor: 'pointer',
          border: '1px solid',
          borderColor: 'divider',
        }}
        onClick={() => setOpen(true)}
        onError={() => setErrored(true)}
      />
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="lg">
        <DialogContent sx={{ p: 1 }}>
          <Box
            component="img"
            src={src}
            alt="Shared image"
            sx={{ maxWidth: '90vw', maxHeight: '90vh', display: 'block' }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

interface TaskCardProps {
  taskId: string;
  prNumber?: string;
  branch?: string;
}

function TaskCard({ taskId, prNumber, branch }: TaskCardProps): React.ReactElement {
  return (
    <Card
      variant="outlined"
      sx={{
        mt: 1,
        borderColor: 'success.main',
        borderRadius: 1.5,
        bgcolor: 'background.paper',
        maxWidth: 380,
      }}
    >
      <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.75 }}>
          <CheckCircleOutlineIcon sx={{ color: 'success.main', fontSize: 18 }} />
          <Typography variant="body2" sx={{ fontWeight: 700, color: 'success.main' }}>
            {taskId} completed
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
          {prNumber && (
            <Chip
              size="small"
              label={`PR #${prNumber}`}
              icon={<OpenInNewIcon sx={{ fontSize: '13px !important' }} />}
              component="a"
              href={`https://github.com/Team-Commonly/commonly/pull/${prNumber}`}
              target="_blank"
              rel="noopener noreferrer"
              clickable
              sx={{ fontSize: '0.7rem', height: 22 }}
            />
          )}
          {branch && (
            <Chip
              size="small"
              label={branch}
              variant="outlined"
              sx={{ fontSize: '0.7rem', height: 22, fontFamily: 'monospace' }}
            />
          )}
        </Box>
      </CardContent>
    </Card>
  );
}

function extractImageUrls(content: string): string[] {
  const matches = content.match(IMAGE_URL_RE);
  if (!matches) return [];
  return [...new Set(matches)];
}

interface MessageContentProps {
  children?: string | null;
  onHashtagClick?: (tag: string) => void;
}

export default function MessageContent({
  children,
  onHashtagClick,
}: MessageContentProps): React.ReactElement | null {
  if (!children) return null;

  const imageUrls = extractImageUrls(children);

  const taskMatch = children.match(TASK_COMPLETE_RE);
  const prMatch = children.match(PR_RE);
  const branchMatch = children.match(BRANCH_RE);
  const taskCard = taskMatch
    ? {
        taskId: taskMatch[1],
        prNumber: prMatch?.[1],
        branch: branchMatch?.[1]?.replace(/[.,;]+$/, ''),
      }
    : null;

  return (
    <>
      <MarkdownContent variant="chat" onHashtagClick={onHashtagClick}>
        {children}
      </MarkdownContent>

      {imageUrls.map((url) => (
        <ImagePreview key={url} src={url} />
      ))}

      {taskCard && (
        <TaskCard
          taskId={taskCard.taskId}
          prNumber={taskCard.prNumber}
          branch={taskCard.branch}
        />
      )}
    </>
  );
}

export { ImagePreview, TaskCard };

// Also add img handler to MarkdownContent — re-export a chat-image aware version
export { default as MarkdownContent } from './MarkdownContent';

// Convenience: for agent task link (used in TaskCard and elsewhere)
export function AgentTaskLink({
  taskId,
  podId,
}: {
  taskId: string;
  podId?: string;
}): React.ReactElement {
  const href = podId ? `/pods/${podId}?task=${taskId}` : '#';
  return (
    <Link href={href} target={podId ? '_self' : '_blank'} underline="hover" variant="body2">
      {taskId} →
    </Link>
  );
}
