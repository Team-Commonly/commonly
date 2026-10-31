# When a new signup stops at the first screen

A new person signs up and sends nothing. Before you walk the flow or change
copy, settle one question: **did they reach the first screen, and did they act
on it?** The account already records the answer.

## Read the onboarding marks first

`User.onboarding` carries write-once first-session marks, each set
server-side (`services/onboardingMarks.ts`). Accounts created before a mark
shipped don't have it; nothing is backfilled.

| mark | set when | tells you |
|---|---|---|
| `podOpenedAt` | the person first loads the messages of a pod they created, such as My Workspace | they reached the workspace and its welcome |
| `firstStartAt` + `firstStartId` | their first message in a pod they created matches a start's label, or the server resolves a click on their own "Run an agent here" | they acted, and which choice |
| `byoOpenedAt` | they first load Bring your own (`GET /api/hosted/availability`) | they looked at setup |

Read them together with the person's first own message in their workspace.

- **No `podOpenedAt`**: they never reached the screen. Look at the signup and
  redirect path.
- **`podOpenedAt` but no `firstStartAt`, no `byoOpenedAt` and no message**:
  they saw the welcome and did nothing. That is a copy or comprehension
  question, not a render bug. Compare against people who did act: how soon
  after `podOpenedAt` did they click?
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
