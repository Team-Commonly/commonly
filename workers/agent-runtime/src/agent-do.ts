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
import { listEvents, ackEvent, postMessage, CapConfig, CapEvent } from './cap';
import { runTurn } from './turn';
import { buildCapTools } from './tools';

export interface Env {
  AGENT: DurableObjectNamespace;
  COMMONLY_API_URL: string;
  // Operator admin secret gating every worker route (wrangler secret).
  RUNTIME_ADMIN_TOKEN?: string;
  // Optional model override (defaults in turn.ts).
  MODEL_ID?: string;
  // 'anthropic' (default) or 'deepseek' — which key/provider the runtime uses.
  MODEL_PROVIDER?: string;
  DEEPSEEK_API_KEY?: string;
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

  // Otto's blockers 2-4 (#1318 review) shape this loop:
  // - per-event try/catch: one throwing event (a transient model 529) must
  //   not abort the batch — the others were already claimed by list() and an
  //   aborted batch strands them for the 10-min requeue, and three strandings
  //   drop a mention permanently.
  // - processed-id dedupe: a successful post whose ACK fails would otherwise
  //   replay the post on redelivery (up to 3 copies in the pod).
  // - deprovision-vs-inflight: re-check provisioning before each event; DO
  //   execution interleaves at await points, so a deprovision can land
  //   mid-batch and must stop further turns.
  async alarm(): Promise<void> {
    const cfg = await this.cfg();
    if (!cfg) return; // deprovisioned — let the alarm chain die
    const pollSeconds = (await this.state.storage.get<number>('pollSeconds')) || POLL_DEFAULT_S;
    try {
      const events = await listEvents(cfg);
      const processed = (await this.state.storage.get<string[]>('processedEventIds')) || [];
      let batchErrors = 0;
      for (const event of events) {
        const stillProvisioned = await this.state.storage.get<string>('runtimeToken');
        if (!stillProvisioned) return;
        try {
          if (!processed.includes(event._id)) {
            await this.handleEvent(cfg, event);
            processed.push(event._id);
            await this.state.storage.put('processedEventIds', processed.slice(-200));
          }
          await ackEvent(cfg, event._id);
        } catch (err) {
          batchErrors += 1;
          await this.state.storage.put('lastError', `event ${event._id}: ${String((err as Error).message)}`);
        }
      }
      await this.state.storage.put('lastPollAt', Date.now());
      // Otto (#1318 round 2): a latched lastError makes a runtime that blipped
      // an hour ago indistinguishable from one broken now — the surface he
      // watches. A clean batch clears it.
      if (batchErrors === 0) await this.state.storage.delete('lastError');
    } catch (err) {
      await this.state.storage.put('lastError', String((err as Error).message));
    } finally {
      if (await this.state.storage.get('runtimeToken')) {
        await this.state.storage.setAlarm(Date.now() + pollSeconds * 1000);
      }
    }
  }

  private async handleEvent(cfg: CapConfig, event: CapEvent): Promise<void> {
    const podId = event.podId || event.payload?.podId;
    if (!podId) return;
    if (event.type !== 'chat.mention' && event.type !== 'first_contact') return;
    // No eager context fetch: the mention is the prompt and read_pod_context
    // earns the read when the model needs it (Otto: two CAP reads per turn
    // and the same content twice against the byte ceiling otherwise).
    const reply = await this.runTurn(String(event.payload?.content || ''), buildCapTools(cfg, podId));
    // NO_REPLY contract: total-match suppression, same as every runtime.
    if (reply && reply.trim() !== 'NO_REPLY') {
      await postMessage(cfg, podId, reply);
    }
  }

  // The pi-driven turn (turn.ts): transcript on DO storage, streamSimple
  // transport, tail-bounded context. Pod context is folded into the prompt
  // as text until CAP tools land (next slice).
  private async runTurn(prompt: string, tools: ReturnType<typeof buildCapTools> = []): Promise<string> {
    // No silent NO_REPLY on a missing key — runTurn throws, the event stays
    // unacked, and /status shows the misconfiguration (Otto, #1339).
    const provider = (this.env.MODEL_PROVIDER === 'deepseek' ? 'deepseek' : 'anthropic') as 'anthropic' | 'deepseek';
    const key = (provider === 'deepseek' ? this.env.DEEPSEEK_API_KEY : this.env.ANTHROPIC_API_KEY) || '';
    const userText = `You were mentioned with: ${prompt}`;
    return runTurn({
      storage: this.state.storage,
      apiKey: key,
      provider,
      modelId: this.env.MODEL_ID,
      tools,
      systemPrompt: 'You are a Commonly hosted agent living in a shared pod with humans and other agents. Reply concisely and usefully to the message you were mentioned in. Use read_pod_context when the mention alone is not enough. If no reply is genuinely needed, reply with exactly NO_REPLY.',
    }, userText);
  }
}
