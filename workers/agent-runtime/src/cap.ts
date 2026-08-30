// The CAP client — the four verbs, fetch-based, exactly what a BYO wrapper
// speaks (ADR-023 D2: the hosted runtime dogfoods CAP; that interface is
// what keeps the substrate swappable). No kernel change anywhere in W2.
export interface CapConfig {
  apiUrl: string;
  runtimeToken: string;
}

export interface CapEvent {
  _id: string;
  type: string;
  podId?: string;
  // ADR-026 D6 (#1347): the claim's delivery nonce. Presented on ack; a
  // 409 stale_delivery means this runtime was superseded for the event.
  deliveryId?: string;
  payload?: { content?: string; podId?: string; [k: string]: unknown };
}

export class StaleDeliveryError extends Error {
  constructor(eventId: string) {
    super(`stale_delivery: event ${eventId} was redelivered to another runtime`);
    this.name = 'StaleDeliveryError';
  }
}

const headers = (cfg: CapConfig) => ({
  Authorization: `Bearer ${cfg.runtimeToken}`,
  'Content-Type': 'application/json',
  // Cloudflare-proxied instances block default UAs (the Python-SDK lesson).
  'User-Agent': 'commonly-hosted-runtime/0.1',
});

export const listEvents = async (cfg: CapConfig): Promise<CapEvent[]> => {
  const res = await fetch(`${cfg.apiUrl}/api/agents/runtime/events?status=pending`, {
    headers: headers(cfg),
  });
  if (!res.ok) throw new Error(`listEvents ${res.status}`);
  const body = (await res.json()) as { events?: CapEvent[] } | CapEvent[];
  return Array.isArray(body) ? body : body.events || [];
};

export const ackEvent = async (cfg: CapConfig, eventId: string, deliveryId?: string): Promise<void> => {
  const res = await fetch(`${cfg.apiUrl}/api/agents/runtime/events/${eventId}/ack`, {
    method: 'POST',
    headers: headers(cfg),
    body: JSON.stringify(deliveryId ? { deliveryId } : {}),
  });
  // 'You were replaced' is not a retryable failure: stop, do not post again.
  // Branch on the body's code, not the bare status (Otto): a generic 409 from
  // anything else must stay a retryable error, not a silent drop.
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as { code?: string };
    if (body.code === 'stale_delivery') throw new StaleDeliveryError(eventId);
  }
  if (!res.ok) throw new Error(`ackEvent ${res.status}`);
};

export const getPodContext = async (cfg: CapConfig, podId: string): Promise<unknown> => {
  const res = await fetch(`${cfg.apiUrl}/api/agents/runtime/pods/${podId}/context?limit=20`, {
    headers: headers(cfg),
  });
  if (!res.ok) throw new Error(`getPodContext ${res.status}`);
  return res.json();
};

export const postMessage = async (cfg: CapConfig, podId: string, content: string): Promise<void> => {
  const res = await fetch(`${cfg.apiUrl}/api/agents/runtime/pods/${podId}/messages`, {
    method: 'POST',
    headers: headers(cfg),
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`postMessage ${res.status}`);
};
