// Router: /agents/:agentName/:instanceId/* → that identity's Durable Object.
// The DO id IS the identity key — per-agent isolation is the platform
// primitive (ADR-023 context #3), not something we engineer.
import { AgentRuntimeDO, Env } from './agent-do';

export { AgentRuntimeDO };

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const match = url.pathname.match(/^\/agents\/([a-z0-9-]+)\/([a-z0-9-]+)(\/.*)$/);
    if (!match) return Response.json({ error: 'expected /agents/:agentName/:instanceId/...' }, { status: 404 });
    const [, agentName, instanceId, rest] = match;
    const id = env.AGENT.idFromName(`${agentName}:${instanceId}`);
    const stub = env.AGENT.get(id);
    const forward = new Request(new URL(rest, url.origin), req);
    return stub.fetch(forward);
  },
};
