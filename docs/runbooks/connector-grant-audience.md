# Diagnose a connector grant that supplies no tools

A pod target chooses the room. `audience` chooses which current members may use
the grant. Both conditions must hold; pod membership alone is not authorization.

- Omit `audience` when minting: the server snapshots the pod's current members.
- Send `audience: []`: nobody receives access. This is explicit, not a wildcard.
- Send agent User IDs: only those IDs intersected with current pod membership
  receive access. New members are not automatically added to a snapshot.

For a failed walk, capture the grant's target, audience, expiry and revocation
alongside the native run's agent User ID, pod ID and start time. A revoked grant
cannot be replayed to diagnose a turn that ran while it was live. Keep credentials
out of the evidence.

An empty-audience mint succeeds with a fixed `empty_audience` warning for the
connection owner. The Tools form warns before submission when no agent is
selected. A native agent that is a current pod member receives a generic
explanation when a live pod grant excludes it. The explanation contains no grant,
connection, provider or owner identifiers and supplies no tools. Expired, revoked,
other-pod and seat-target grants produce no such notice.

The native projection offers pinned tool definitions. A hosted-MCP assessment
runs on a broker call; the absence of an assessment log alone does not prove that
projection failed.

Regression coverage: `backend/__tests__/service/native-hosted-grant-projection.test.js`
uses real Mongo User, Pod, RoomGrant and AgentRun rows and the actual native
runtime, with only model and posting I/O mocked. Route and UI tests pin the empty
versus omitted audience distinction and the granting user's explanation.
