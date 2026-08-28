// One Durable Object per (agentName, instanceId) — ADR-023's selected design.
// Single-threaded per object, so ADR-021's within-engine claims problem is a
// platform property here (claims remain for cross-engine arbitration only).
//
// Wake model (W2 v1): DO alarms poll CAP on a short interval while
// provisioned — behaviorally identical to a CLI wrapper, requiring ZERO
// kernel change. Push delivery is a later optimization, not a prerequisite.
//
// Turn engine: pi agent-core with an injected fetch-based streamFn (the
// spike's finding #2: transport is dependency-injected and workerd-clean).
// v1 wires a minimal turn; harness/compaction integration follows.
import { listEvents, ackEvent, getPodContext, postMessage, CapConfig, CapEvent } from './cap';

export interface Env {
  AGENT: DurableObjectNamespace;
  COMMONLY_API_URL: string;
  // Model transport for the injected streamFn. BYOK per instance; metering
  // ships WITH hosted agents, not after (ADR-023 D3.1) — see TODO below.
  ANTHROPIC_API_KEY?: string;
}

interface ProvisionBody {
  agentName: string;
  instanceId: string;
  runtimeToken: string;
  pollSeconds?: number;
}

const POLL_DEFAULT_S = 5;

export class AgentRuntimeDO implements DurableObject {
  constructor(private state: DurableObjectState, private env: Env) {}

  private async cfg(): Promise<CapConfig | null> {
    const token = await this.state.storage.get<string>('runtimeToken');
    if (!token) return null;
    return { apiUrl: this.env.COMMONLY_API_URL, runtimeToken: token };
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/provision') {
      const body = (await req.json()) as ProvisionBody;
      if (!body.runtimeToken || !body.agentName) {
        return Response.json({ error: 'agentName and runtimeToken required' }, { status: 400 });
      }
      await this.state.storage.put({
        agentName: body.agentName,
        instanceId: body.instanceId || 'default',
        runtimeToken: body.runtimeToken,
        pollSeconds: body.pollSeconds || POLL_DEFAULT_S,
        provisionedAt: Date.now(),
      });
      await this.state.storage.setAlarm(Date.now() + 1000);
      return Response.json({ provisioned: true });
    }
    if (req.method === 'POST' && url.pathname === '/deprovision') {
      await this.state.storage.deleteAll();
      await this.state.storage.deleteAlarm();
      return Response.json({ deprovisioned: true });
    }
    if (url.pathname === '/status') {
      const [agentName, provisionedAt, lastPollAt, lastError] = await Promise.all([
        this.state.storage.get('agentName'),
        this.state.storage.get('provisionedAt'),
        this.state.storage.get('lastPollAt'),
        this.state.storage.get('lastError'),
      ]);
      return Response.json({ agentName: agentName || null, provisionedAt, lastPollAt, lastError });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  }

  async alarm(): Promise<void> {
    const cfg = await this.cfg();
    if (!cfg) return; // deprovisioned — let the alarm chain die
    const pollSeconds = (await this.state.storage.get<number>('pollSeconds')) || POLL_DEFAULT_S;
    try {
      const events = await listEvents(cfg);
      for (const event of events) {
        await this.handleEvent(cfg, event);
        await ackEvent(cfg, event._id);
      }
      await this.state.storage.put('lastPollAt', Date.now());
      await this.state.storage.delete('lastError');
    } catch (err) {
      await this.state.storage.put('lastError', String((err as Error).message));
    } finally {
      await this.state.storage.setAlarm(Date.now() + pollSeconds * 1000);
    }
  }

  private async handleEvent(cfg: CapConfig, event: CapEvent): Promise<void> {
    const podId = event.podId || event.payload?.podId;
    if (!podId) return;
    if (event.type !== 'chat.mention' && event.type !== 'first_contact') return;
    const context = await getPodContext(cfg, podId);
    const reply = await this.runTurn(String(event.payload?.content || ''), context);
    // NO_REPLY contract: total-match suppression, same as every runtime.
    if (reply && reply.trim() !== 'NO_REPLY') {
      await postMessage(cfg, podId, reply);
    }
  }

  // v1 turn: direct Anthropic call through the injected-transport seam the
  // spike proved. pi AgentHarness + compaction integration is the next PR —
  // the seam (string in, string out, context available) does not change.
  private async runTurn(prompt: string, _context: unknown): Promise<string> {
    const key = this.env.ANTHROPIC_API_KEY;
    if (!key) return 'NO_REPLY';
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt || 'You were woken with no content.' }],
        system: 'You are a Commonly hosted agent. Reply concisely and usefully to the pod message you were mentioned in. If no reply is genuinely needed, reply with exactly NO_REPLY.',
      }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}`);
    const body = (await res.json()) as { content?: { text?: string }[] };
    return body.content?.map((c) => c.text || '').join('') || 'NO_REPLY';
  }
}
