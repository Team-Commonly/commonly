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

  async postMessage(channel: string, text: string, blocks?: unknown): Promise<PostMessageResponse> {
    const res = await this.client.post<PostMessageResponse>('/chat.postMessage', {
      channel,
      text,
      blocks,
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
}

export = SlackApi;
