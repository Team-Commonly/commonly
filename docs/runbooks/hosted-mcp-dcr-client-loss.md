# A hosted-MCP DCR client the vendor deleted

A hosted-MCP entry with `client: 'dcr'` registers one OAuth client per instance
(`backend/services/hostedMcpDcrRegistry.ts`). If the vendor deletes that
client, for example in a developer console clean-up, every new connect lands on
the vendor's own error page. The vendor never redirects back, so this instance
never sees the failure.

## What happens on its own

When a member starts a connect while their last start is still pending (it
never came back), the start route asks the vendor about the client that start
used. It sends a made-up code to the token endpoint:

- `invalid_client`: the vendor no longer knows the client. It is retired, and
  this same start registers a new client, so the member's retry works.
- `invalid_grant`: the client is fine. Nothing changes.
- Anything else, including no answer: nothing changes.

The vendor is asked about a registration at most once every 10 minutes.

A retired client is not refused. Rows it already minted keep refreshing with
it, and the registration is refused only when the vendor refuses one of their
own token calls with `invalid_client`.

## By hand

Run the admin command from ops-runner (never inside the serving backend, see
`ops-runner-and-no-exec-into-backend.md`):

```bash
npm run retire:hosted-mcp-dcr-client                       # list current clients and the rows each minted
npm run retire:hosted-mcp-dcr-client -- --ask              # also ask each vendor about its client
npm run retire:hosted-mcp-dcr-client -- --ask --apply      # retire every client its vendor no longer knows
npm run retire:hosted-mcp-dcr-client -- --retire <entryId> --apply   # retire one entry's client
```

Use `--retire` for a vendor whose token endpoint does not answer
`invalid_client` for an unknown client. Nothing is written without `--apply`.

Never delete a registration row. Connected rows still name its client.
