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
    const url = new URL(req.url);
    const match = url.pathname.match(/^\/agents\/([a-z0-9-]+)\/([a-z0-9-]+)(\/.*)$/);
    if (!match) return Response.json({ error: 'expected /agents/:agentName/:instanceId/...' }, { status: 404 });
    const [, agentName, instanceId, rest] = match;
    // Two bearers, two capabilities. The admin token provisions, deprovisions
    // and reads. The optional status token reads /status and nothing else —
    // a watcher (Otto, a dashboard, an alert) needs health, not the power to
    // kill or provision any agent by name. Unset means no second bearer.
    const bearer = req.headers.get('Authorization');
    const isAdmin = bearer === `Bearer ${admin}`;
    // A status token EQUAL to the admin token is a refused CONFIGURATION
    // (Otto on #1374, round 2): nulling the reader path closes nothing,
    // because the byte-identical bearer still authenticates as admin — no
    // logic here can tell the two holders apart. The only remedy is to
    // refuse to serve until the operator fixes the secrets.
    if (env.RUNTIME_STATUS_TOKEN && env.RUNTIME_STATUS_TOKEN === admin) {
      return Response.json({ error: 'misconfigured: RUNTIME_STATUS_TOKEN must differ from RUNTIME_ADMIN_TOKEN' }, { status: 503 });
    }
    const isStatusReader = Boolean(env.RUNTIME_STATUS_TOKEN) && bearer === `Bearer ${env.RUNTIME_STATUS_TOKEN}`;
    const statusOnly = req.method === 'GET' && rest === '/status';
    if (!isAdmin && !(isStatusReader && statusOnly)) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    const id = env.AGENT.idFromName(`${agentName}:${instanceId}`);
    const stub = env.AGENT.get(id);
    const forward = new Request(new URL(rest, url.origin), req);
    return stub.fetch(forward);
  },
};
