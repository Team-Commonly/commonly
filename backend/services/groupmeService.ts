import axios from 'axios';

const GROUPME_API_BASE = 'https://api.groupme.com/v3';

interface SendResult {
  success: boolean;
  error?: string;
}

interface FetchOptions {
  groupId: string;
  accessToken: string;
  limit?: number;
  before?: string;
  after?: string;
}

interface NormalizedMessage {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  timestamp: string | null;
  attachments: string[];
  reactions: unknown[];
  isBot: boolean;
}

interface GroupMeMessageRaw {
  id: string;
  user_id?: string;
  sender_id?: string;
  name?: string;
  text?: string;
  created_at?: number;
  attachments?: Array<{ url?: string; text?: string }>;
  sender_type?: string;
}

interface GroupMeHistoryResponse {
  response?: {
    messages?: GroupMeMessageRaw[];
  };
}

interface FetchParams {
  token: string;
  limit: number;
  before_id?: string;
  after_id?: string;
}

async function sendMessage(botId: string, text: string): Promise<SendResult> {
  if (!botId || !text) {
    return { success: false, error: 'Missing botId or text' };
  }

  try {
    const response = await axios.post(`${GROUPME_API_BASE}/bots/post`, {
      bot_id: botId,
      text,
    });

    console.log('GroupMe message sent', { botId, status: response.status });
    return { success: response.status === 202 };
  } catch (error) {
    const err = error as { response?: { data: unknown }; message: string };
    console.error('Error sending GroupMe message:', err.response?.data || err.message);
    return { success: false, error: err.message };
  }
}

async function fetchMessages(options: FetchOptions = {} as FetchOptions): Promise<NormalizedMessage[]> {
  const {
    groupId, accessToken, limit = 50, before, after,
  } = options;

  if (!groupId || !accessToken) {
    throw new Error('Missing groupId or accessToken');
  }

  const params: FetchParams = {
    token: accessToken,
    limit: Math.min(Math.max(parseInt(String(limit), 10) || 50, 1), 100),
  };

  if (before) params.before_id = before;
  if (after) params.after_id = after;

  const response = await axios.get<GroupMeHistoryResponse>(
    `${GROUPME_API_BASE}/groups/${groupId}/messages`,
    { params },
  );
  const messages = response.data?.response?.messages || [];

  return messages.map((msg) => ({
    id: msg.id,
    authorId: msg.user_id || msg.sender_id || '',
    authorName: msg.name || 'Unknown',
    content: msg.text || '',
    timestamp: msg.created_at ? new Date(msg.created_at * 1000).toISOString() : null,
    attachments: (msg.attachments || []).map((att) => att.url || att.text || '').filter(Boolean),
    reactions: [],
    isBot: msg.sender_type === 'bot',
  }));
}

export { sendMessage, fetchMessages };
