# When a new signup stops at the first screen

A new person signs up and sends nothing. Before you walk the flow or change
copy, settle one question: **did they reach the first screen, and did they act
on it?** The account usually records evidence of both.

## Read the onboarding marks first

`User.onboarding` carries write-once first-session marks, each set
server-side (`services/onboardingMarks.ts`).

**A missing mark means "no mark recorded", not proof the step didn't happen.**
The writes are fire-and-forget: `markPodOpened` calls `User.updateOne(...)`
without awaiting it, and a failed write leaves the mark unset after a real
visit. `podOpenedAt` and a typed `firstStartAt` count only in a pod the
person created; `byoOpenedAt` has no pod check. Nothing is backfilled, and
nothing checks when the account was created: an account created before that
mark's deploy gets it on its first eligible request afterwards, so its
timestamp can be later than the real first visit. Treat a gap as a lead to
confirm, for example against `lastActive` or whether they sent a message
(timestamps and ids).

| mark | set when | tells you |
|---|---|---|
| `podOpenedAt` | the first authorized first-page fetch (no `before` cursor) of the messages of any pod they created; for a new signup that is normally My Workspace. It is set before the messages are read, so it records the request, not a render | their client asked for a pod's messages; for a new signup, very likely the welcome |
| `firstStartAt` + `firstStartId` | their first message in a pod they created matches a start's label, or the server resolves a click on their own "Run an agent here" | they acted, and which choice |
| `byoOpenedAt` | they first load Bring your own (`GET /api/hosted/availability`) | they looked at setup |
| `byoOpenedOs` | written with `byoOpenedAt`, from the `?os=` the page sends: `mac`, `linux`, `windows` or `other`. Unset for anyone who opened the page before it shipped, and for an unknown value | whether the listener path (Mac only) could have worked for them |
| `byoCommandCopiedAt` + `byoCommandType` | the first setup command they copy on Bring your own, `mcp` or `cli`; never overwritten, and never the command itself | they started setup, and with which kind |
| `byoMcpCopiedAt`, `byoCliCopiedAt` | the first copy of each kind, written once each (TASK-721). Unset for copies made before they shipped; the stalled-connect nudge then falls back to the pair above. The marks are per person, not per agent, so the nudge counts a kind only when it falls after the stalled token was issued | whether they copied the MCP snippet and never the listener command |

Read them together with whether the person sent a message in their workspace,
and when (timestamps and ids).

- **No `podOpenedAt`**: no messages fetch was recorded for their own pod. They
  may never have reached the workspace, or the write may have failed. Check
  `lastActive` first, then look at the signup and redirect path.
- **`podOpenedAt` but no `firstStartAt`, no `byoOpenedAt` and no message**:
  a first-page fetch of a pod they created was made (for a new signup,
  normally My Workspace, where the welcome is). The mark is written before the
  messages are listed, so it doesn't prove the welcome showed. First rule out
  a failed fetch or render: walk it on staging, and check the backend error
  logs around `podOpenedAt`. Only then treat it as a copy or comprehension
  question. Compare against people who did act: how soon after `podOpenedAt`
  did they click?
- **`firstStartAt` but nothing after it**: the click is the place to look,
  above all `run-hosted`. It sends no message, and the mark is set when the
  server resolves the click, before the install and provision run. So a
  hosted start that then failed leaves only this mark.

Prod reads go through a throwaway read pod
([`ops-runner-and-no-exec-into-backend.md`](ops-runner-and-no-exec-into-backend.md)).
Read timestamps, ids and the welcome payload's start ids, never message text.

## Then walk it, knowing what staging cannot show

A fresh signup on staging confirms the render: the final URL, whether the
welcome arrives in the first messages fetch, and whether the starts sit above
the fold at desktop and phone widths. Two things differ from prod:

- **Staging has no hosted engine**, so the welcome offers two starts, not
  three. "Run an agent here" is added only when `hostedEngineAvailable()`. Its
  behaviour has to come from the code (`useWelcomeHostedStart`,
  `services/welcomeHostedStart.ts`) or from the stored prod payload.
- **A staging signup redeems an invite**, which sets
  `entitlements.cloudAgents = true`. Prod signups default to `false`. Hosted
  agents are metered rather than entitlement-gated, but record which state you
  walked.

## Where the welcome lives

The welcome body is server-composed at signup and stored once, by locale:
`scoutWelcomeFor` in `backend/config/native-agents/scout.ts`. A copy change
reaches new workspaces only. The starts ride the message payload
(`kind: 'starts'`), so the buttons never depend on the text.

Earned on TASK-644 (2026-10-30). Two Google signups stalled. The marks showed
both opened their workspace within 4s and never clicked, and a staging walk
found the screen clean. The fix was the welcome line (#3036), not code.
