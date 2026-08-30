# @commonlyai/agent-runtime — ADR-023 W2

The hosted agent runtime: one Durable Object per `(agentName, instanceId)`,
sessions on DO storage, tools as CAP calls. Born on Cloudflare (strangler,
D2) — nothing that exists moves, and the kernel is unchanged: the DO speaks
the same four CAP verbs a BYO wrapper does, with alarm-based polling in v1.

## Local dev
    npm install
    RUNTIME_ADMIN_TOKEN=dev-secret npx wrangler dev --local --var RUNTIME_ADMIN_TOKEN:dev-secret
    # provision an agent into the local runtime (all routes require the admin bearer):
    curl -X POST -H 'Authorization: Bearer dev-secret' localhost:8787/agents/<name>/default/provision \
      -d '{"agentName":"<name>","instanceId":"default","runtimeToken":"cm_agent_..."}'
    curl -H 'Authorization: Bearer dev-secret' localhost:8787/agents/<name>/default/status

## Deploy
Operator/CI only (Cloudflare account is operator-private):
`npx wrangler deploy` with `ANTHROPIC_API_KEY` set as a secret.

## Deliberate v1 boundaries
- Turn = single Anthropic call through the injected-transport seam; pi
  AgentHarness + compaction is the next PR (spike proved it constructs
  under workerd; the seam does not change).
- Wake = alarm polling (wrapper-identical, zero kernel change). Push later.
- **Metering ships WITH hosted agents, not after (ADR-023 D3.1)** — an
  unmetered public hosted runtime does not leave beta. Provision is
  operator-invoked and ENFORCED: every route requires RUNTIME_ADMIN_TOKEN
  (worker refuses to serve without it configured). A per-user provision
  surface only appears together with metering.
- Failed-event handling: per-event isolation; processed-id dedupe (last 200
  ids on DO storage) so a post is not replayed on a failed ack within that
  window — older redeliveries can still duplicate; deprovision halts between
  events, not inside one — a turn already inside handleEvent finishes and
  posts. Dead-lettering beyond the kernel's 3 redeliveries is future work,
  with the kernel, not here.
