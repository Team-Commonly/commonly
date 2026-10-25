# The second-person invite moment

`V2BringTeammate` uses the existing pod invite model and member-authorized API.
It appears for the sole human in a group pod, after that person's first agent
reply, in the owned Scout workspace, or in the ordinary empty state. An
incomplete history cannot establish the first reply. Direct-message pod types
are excluded. Membership changes remove the prompt when a second human joins.

An impression performs only GET. A press reuses this user's usable link for the
same placement, or creates one with a seven-day expiry. Clipboard refusal keeps
and selects that link; retry never creates another token. Returning links are
shown without claiming the new browser has copied them. Dismissal is local to
the pod and placement. The just-created-pod starter also creates only on press.

Placement sources are `first-agent-post`, `scout-first-session`, and `solo-pod`;
legacy/menu writes default to `pod-menu`. Source is client-provided attribution,
not an authorization claim. Inviter identity and cohort time are server-bound.

## Measurement

Admin-only `GET /api/admin/analytics/invites?days=30` returns aggregate counts,
with a one-to-90-day window. It excludes internal and bot inviters using the
shared classification policy and never returns invite tokens or person IDs.

- `created`: successful invite rows, counted by creation time and source.
- `used`: the first **new outside human** joining with that invite. Self uses,
  already-member repeats, staff and bots do not convert a team. The existing
  raw `useCount` still counts redemptions and is unchanged.
- `inviters` / `convertedInviters`: distinct outside inviters in each cohort.
- Cohort: UTC day of the inviter's immutable `onboarding.podOpenedAt`, copied at
  mint. This is the first observed opening of a pod they created, not a claim
  about an unobserved authentication session. Missing legacy marks are an
  explicit `null` cohort.

Usage measurement starts at deployment: legacy redemption counters are not
backfilled as teammate joins. Telemetry failures do not undo a successful mint
or membership join. The endpoint reports the forward-only limitation explicitly.
