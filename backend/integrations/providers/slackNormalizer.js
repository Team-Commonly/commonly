function normalizeSlackMessage(event) {
  if (!event || event.type !== 'message' || event.subtype) return null;
  return {
    source: 'slack',
    externalId: event.client_msg_id || event.ts,
    threadId: event.thread_ts || null,
    authorId: event.user,
    authorName: event.user, // can be enriched later via users.info
    content: event.text || '',
    timestamp: new Date(Number(event.ts.split('.')[0]) * 1000).toISOString(),
    attachments: [],
    metadata: {
      channelId: event.channel,
    },
  };
}

module.exports = { normalizeSlackMessage };
