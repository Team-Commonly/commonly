import type { Api } from './api';

export interface Pod {
  _id: string;
  name: string;
  type?: string;
  description?: string;
  members?: unknown[];
  createdBy?: string;
  [key: string]: unknown;
}

export interface Message {
  id: string | number;
  content: string;
  createdAt?: string;
  user?: { _id?: string; username?: string; displayName?: string; isBot?: boolean; botMetadata?: unknown; avatarUrl?: string };
  username?: string;
  userId?: string;
  isBot?: boolean;
  threadRootId?: string | number | null;
  [key: string]: unknown;
}

/** Pod types that are one-to-one rooms rather than a workspace. */
const DM_TYPES = new Set(['agent-room', 'agent-dm', 'dm']);

export class Pods {
  constructor(private readonly api: Api) {}

  /** GET /api/pods — the pods the signed-in user is a member of. */
  async list(): Promise<Pod[]> {
    const res = await this.api.get<Pod[] | { pods: Pod[] }>('/api/pods');
    return Array.isArray(res) ? res : (res.pods ?? []);
  }

  /**
   * The user's workspace: the first pod that is not a one-to-one room.
   * Sign-up creates exactly one, so for a new user this is deterministic.
   */
  async workspace(userId?: string): Promise<Pod | null> {
    const pods = await this.list();
    const candidates = pods.filter((p) => !DM_TYPES.has(String(p.type || '')));
    const mine = userId ? candidates.filter((p) => String(p.createdBy) === String(userId)) : [];
    return mine.find((p) => String(p.type || '') !== 'public') ?? mine[0] ?? candidates[0] ?? pods[0] ?? null;
  }

  /** GET /api/messages/:podId. The API answers newest-first; this returns chronological (newest LAST). */
  async messages(podId: string, limit = 50): Promise<Message[]> {
    const res = await this.api.get<Message[] | { messages: Message[] }>(`/api/messages/${encodeURIComponent(podId)}?limit=${limit}`);
    const list = Array.isArray(res) ? res : (res.messages ?? []);
    const ts = (m: Message) => new Date(m.createdAt || 0).getTime();
    return [...list].sort((a, b) => ts(a) - ts(b));
  }

  /** POST /api/messages/:podId — post as the signed-in user. Returns the stored message and agent delivery info. */
  send(podId: string, content: string, opts: { threadRootId?: string | number; replyToMessageId?: string | number } = {}) {
    return this.api.post<Message & { agentDelivery?: unknown }>(`/api/messages/${encodeURIComponent(podId)}`, { content, ...opts });
  }
}
