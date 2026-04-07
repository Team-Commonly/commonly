interface SlackEvent {
  type?: string;
  subtype?: string;
  client_msg_id?: string;
  ts?: string;
  thread_ts?: string;
  user?: string;
  text?: string;
  channel?: string;
  [key: string]: unknown;
}

interface NormalizedSlackMessage {
  source: 'slack';
  externalId: string;
  threadId: string | null;
  authorId: string | undefined;
  authorName: string | undefined;
  content: string;
  timestamp: string;
  attachments: unknown[];
  metadata: { channelId: string | undefined };
}

function normalizeSlackMessage(event: SlackEvent): NormalizedSlackMessage | null {
  if (!event || event.type !== 'message' || event.subtype) return null;
  return {
    source: 'slack',
    externalId: event.client_msg_id || event.ts || '',
    threadId: event.thread_ts || null,
    authorId: event.user,
    authorName: event.user,
    content: event.text || '',
    timestamp: new Date(Number((event.ts || '0').split('.')[0]) * 1000).toISOString(),
    attachments: [],
    metadata: {
      channelId: event.channel,
    },
  };
}

module.exports = { normalizeSlackMessage };
