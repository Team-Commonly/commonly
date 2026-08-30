// Router: /agents/:agentName/:instanceId/* → that identity's Durable Object.
// The DO id IS the identity key — per-agent isolation is the platform
// primitive (ADR-023 context #3), not something we engineer.
import { AgentRuntimeDO, Env } from './agent-do';

export { AgentRuntimeDO };

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // Otto's blocker 1 (#1318 review): with no auth, a deployed worker's
    // /provision, /deprovision and /status are world-reachable — anyone can
    // kill an agent or provision onto the operator's model key. Every route
    // requires the admin secret; "operator-invoked" is now enforced, not
    // asserted.
    const admin = env.RUNTIME_ADMIN_TOKEN;
    if (!admin) return Response.json({ error: 'runtime not configured (RUNTIME_ADMIN_TOKEN unset)' }, { status: 503 });
    const bearer = req.headers.get('Authorization');
    if (bearer !== `Bearer ${admin}`) return Response.json({ error: 'unauthorized' }, { status: 401 });
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
