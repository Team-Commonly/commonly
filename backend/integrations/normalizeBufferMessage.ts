interface RawMessage {
  messageId?: unknown;
  externalId?: unknown;
  authorId?: unknown;
  authorName?: string;
  content?: string;
  timestamp?: unknown;
  attachments?: Array<string | null | { url?: string; title?: string }>;
  [key: string]: unknown;
}

interface NormalizedMessage {
  messageId?: string;
  authorId?: string;
  authorName: string;
  content: string;
  timestamp: Date;
  attachments: string[];
}

function normalizeBufferMessage(message: RawMessage | null | undefined): NormalizedMessage | null {
  if (!message) return null;

  const externalId = message.messageId || message.externalId;
  let attachments: string[] = [];
  if (Array.isArray(message.attachments)) {
    attachments = message.attachments
      .map((attachment) => {
        if (!attachment) return null;
        if (typeof attachment === 'string') return attachment;
        if ((attachment as { url?: string }).url) return (attachment as { url: string }).url;
        if ((attachment as { title?: string }).title) return (attachment as { title: string }).title;
        return null;
      })
      .filter((a): a is string => a !== null);
  }
  const content =
    message.content || (attachments.length ? 'Shared an attachment' : '');

  return {
    messageId: externalId ? String(externalId) : undefined,
    authorId: message.authorId ? String(message.authorId) : undefined,
    authorName: message.authorName || 'Unknown',
    content,
    timestamp: message.timestamp ? new Date(message.timestamp as string) : new Date(),
    attachments,
  };
}

module.exports = { normalizeBufferMessage };
