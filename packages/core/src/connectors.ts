import type { Api } from './api';

export type ConnectorType = 'telegram' | 'slack' | 'discord' | 'imessage';

export interface Integration {
  _id: string;
  podId: string;
  type: ConnectorType | string;
  status: 'pending' | 'connected' | 'error' | string;
  isActive?: boolean;
  config?: {
    connectCode?: string;
    connectCodeExpiresAt?: string;
    chatId?: string;
    chatType?: string;
    chatTitle?: string;
    liveRelay?: boolean;
    relayAllAgentMessages?: boolean;
    [key: string]: unknown;
  };
  createdAt?: string;
  [key: string]: unknown;
}

/**
 * Connectors are the product. This is the whole client contract for them:
 * create one for a pod, read its state, and (for code-based channels) the
 * one-time connect code the user redeems inside the channel.
 *
 * Telegram today: POST creates a pending integration with a server-minted
 * 128-bit code; the user opens the Commonly bot and sends
 * `/commonly-enable <code>`; the webhook binds the chat and flips status to
 * `connected`. Slack and iMessage land on the same shape.
 */
export class Connectors {
  constructor(private readonly api: Api) {}

  /** GET /api/integrations/user/all — every connector the signed-in user can see, across pods. */
  async listAll(): Promise<Integration[]> {
    const res = await this.api.get<Integration[] | { integrations: Integration[] }>('/api/integrations/user/all');
    return Array.isArray(res) ? res : (res.integrations ?? []);
  }

  async list(podId: string): Promise<Integration[]> {
    const all = await this.listAll();
    return all.filter((i) => String(i.podId) === String(podId));
  }

  /** The backend has no per-id read; a connector is read through its pod's list. */
  async get(podId: string, id: string): Promise<Integration | null> {
    const list = await this.list(podId);
    return list.find((i) => String(i._id) === String(id)) ?? null;
  }

  /** Create a Telegram connector for a pod. Defaults on the server: live relay on, mirror mode, linked to the caller. */
  async createTelegram(podId: string): Promise<Integration> {
    const res = await this.api.post<{ integration: Integration }>('/api/integrations', { podId, type: 'telegram', config: {} });
    return res.integration;
  }

  /** Re-mint a connect code for an existing pending connector. */
  async refreshCode(id: string): Promise<Integration> {
    const res = await this.api.post<{ integration: Integration }>(`/api/integrations/${encodeURIComponent(id)}/connect-code`);
    return res.integration;
  }

  /**
   * Poll until the connector leaves `pending` or the deadline passes. Resolves
   * with the latest state either way; the caller decides what "still pending"
   * means on screen. Never throws on a transient read failure.
   */
  async waitForConnected(podId: string, id: string, opts: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Integration | null> {
    const interval = opts.intervalMs ?? 3000;
    const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60 * 1000);
    let last: Integration | null = null;
    while (Date.now() < deadline && !opts.signal?.aborted) {
      try {
        last = await this.get(podId, id);
        if (last && last.status !== 'pending') return last;
      } catch { /* transient; keep polling */ }
      await new Promise((r) => setTimeout(r, interval));
    }
    return last;
  }
}
