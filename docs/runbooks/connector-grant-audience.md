# Diagnose a connector grant that supplies no tools

A pod target chooses the room. `audience` chooses which current members may use
the grant. Both conditions must hold; pod membership alone is not authorization.

- Omit `audience` when minting: the server snapshots the pod's current members.
- Send agent User IDs: only those IDs intersected with current pod membership
  receive access. New members are not automatically added to a snapshot.
- An explicit `audience: []` on a new pod grant returns `400 invalid_audience`:
  "name at least one agent, or omit audience for all current members".
- A seat grant defaults to exactly its target seat; an explicit audience must
  contain exactly that seat and no other member.

The Tools dialog requires at least one selected agent before submission. It
never substitutes an omitted audience when the selection is empty: doing so
would grant the current pod-member snapshot instead of the user's selection.

Existing empty-audience rows still authorize nobody. Do not reinterpret them as
all members or backfill them automatically. To repair a walk, mint a new grant
with the intended agent IDs or deliberately omit audience for a member snapshot.

For a failed walk, capture the grant's target, audience, expiry and revocation
alongside the native run's agent User ID, pod ID and start time. Keep credentials
out of the evidence. Native projection offers pinned definitions; assessment
runs on a broker call, so no assessment log alone does not prove projection failed.

Regression coverage: `backend/__tests__/service/native-hosted-grant-projection.test.js`
uses real Mongo User, Pod, RoomGrant and AgentRun rows and the actual native
runtime, with model/posting I/O mocked. Route tests pin empty-pod refusal,
omitted-member snapshots and the existing seat rule. UI tests pin deselection,
no POST while empty, and re-selection with an explicit audience.
