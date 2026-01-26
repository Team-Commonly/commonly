function normalizeBufferMessage(message) {
  if (!message) return null;

  const externalId = message.messageId || message.externalId;
  const attachments = Array.isArray(message.attachments)
    ? message.attachments
        .map((attachment) => {
          if (!attachment) return null;
          if (typeof attachment === 'string') return attachment;
          if (attachment.url) return attachment.url;
          if (attachment.title) return attachment.title;
          return null;
        })
        .filter(Boolean)
    : [];
  const content = message.content
    || (attachments.length ? 'Shared an attachment' : '');

  return {
    messageId: externalId ? String(externalId) : undefined,
    authorId: message.authorId ? String(message.authorId) : undefined,
    authorName: message.authorName || 'Unknown',
    content,
    timestamp: message.timestamp ? new Date(message.timestamp) : new Date(),
    attachments,
  };
}

module.exports = { normalizeBufferMessage };
