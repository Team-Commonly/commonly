import axios, { AxiosInstance } from 'axios';

interface PostMessageResponse {
  ok: boolean;
  ts?: string;
  error?: string;
  [key: string]: unknown;
}

interface HistoryResponse {
  ok: boolean;
  messages?: unknown[];
  error?: string;
  [key: string]: unknown;
}

interface HistoryParams {
  channel: string;
  limit: number;
  oldest?: string;
  latest?: string;
}

interface ConversationOpenResponse {
  ok: boolean;
  channel?: { id?: string };
  error?: string;
}

class SlackApi {
  private client: AxiosInstance;

  constructor(botToken: string) {
    this.client = axios.create({
      baseURL: 'https://slack.com/api',
      headers: {
        Authorization: `Bearer ${botToken}`,
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Slack mrkdwn treats `&`, `<` and `>` as markup: `<https://x|label>` renders
   * as a link and `<!channel>` as a mention, so a pod name or a message body
   * that reaches a human's DM unescaped can be made to say what the bot never
   * said. It lives here, one step above the single call that posts, so an
   * escaped call site cannot sit beside an unescaped one in the same file —
   * which is how this recurred in two of them (wren 73822, vera 73824).
   *
   * `??` rather than `||`: a missing value must render as nothing, while a
   * legitimate `0` or `false` still renders as itself. `String(undefined)` is
   * the string "undefined", which a human reads as a bug.
   */
  static escapeSlackMrkdwn(value: unknown): string {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  async postMessage(channel: string, text: string, blocks?: unknown, threadTs?: string): Promise<PostMessageResponse> {
    const res = await this.client.post<PostMessageResponse>('/chat.postMessage', {
      channel,
      text,
      blocks,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    return res.data;
  }

  async history(channel: string, oldest?: string, latest?: string, limit = 200): Promise<HistoryResponse> {
    const params: HistoryParams = { channel, limit };
    if (oldest) params.oldest = oldest;
    if (latest) params.latest = latest;
    const res = await this.client.get<HistoryResponse>('/conversations.history', { params });
    return res.data;
  }

  async openConversation(userId: string): Promise<ConversationOpenResponse> {
    const res = await this.client.post<ConversationOpenResponse>('/conversations.open', {
      users: userId,
    });
    return res.data;
  }
}

export = SlackApi;
