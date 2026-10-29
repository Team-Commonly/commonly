# Hosted MCP SDK boundary

`backend/services/hostedMcpToolDefinitions.ts` uses the existing
`@modelcontextprotocol/sdk` dependency (`Client` and
`StreamableHTTPClientTransport`) for upstream MCP. The SDK owns request IDs,
initialization, negotiated headers and JSON/SSE envelope decoding. Commonly's
catalogue, grant checks, credential refresh and drift comparison remain outside
it. A connection is short-lived and uses the same member's credential for its
list or call.

The SDK gets a guarded fetch implementation, **not** an OAuth auth provider.
A vendor 401/403 remains `credential_rejected`; it never triggers SDK OAuth
metadata discovery, refresh or authorization. Every network request still uses
`hostedVendorFetch` and the pinned-address outbound guard. Optional background
GET event streams are disabled for these request/response sessions. SDK stream
reconnection is disabled; only a session-bound HTTP 404 earns one fresh
initialization and retry. The initialized notification has the same bounded
renewal rule as before.

The transport's public protocol setter enforces the existing supported versions
(`2025-03-26`, `2025-06-18`, `2025-11-25`) before sending the initialized
notification. SDK support for an older version does not expand that policy.
The guard forwards only the needed `mcp-session-id` response header, in addition
to the existing media type and redirect location. It does not forward cookies
or arbitrary vendor response headers. Test through this guard: a mocked fetch
that preserves every header can hide a production session-header loss.

Commonly retains the 30-second whole-operation deadline, 4 MiB per-response
limit, paginated list bounds and 24,000-character model result cap. The SDK
validates wire envelopes; the broker still distinguishes missing/malformed tool
lists with its existing failure names. Tool-level `isError` remains a model
result. The first request error is mapped before cleanup, retaining vendor HTTP
status, RPC code and a bounded/redacted diagnostic; DELETE failure cannot
replace it. SDK errors' arbitrary data are never included in the trail.

Fixtures must speak real MCP: advertise tools, echo the current request ID and
terminate SSE events with blank lines. The SDK rejects malformed frames or
mismatched response IDs that the removed parser could mistake for a reply.
Tests use captured Linear and Atlassian tool lists without live credentials.

The production outbound guard currently buffers bounded response bodies before
returning a Response, as it did before this change. An injected streaming fetch
also exercises early SSE completion and reader cancellation; that test is not
proof of production socket streaming. This change does not deploy or re-walk a
vendor. Connector owners perform authenticated walks after deployment.

SDK reference: [Streamable HTTP client transport](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/src/client/streamableHttp.ts).
