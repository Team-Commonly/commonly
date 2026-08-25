# In-pod browser view — scoping note (TASK-060)

**Status:** proposal, not a design ruling. Written under the 2026-08-24 UI
freeze, so it deliberately proposes no v2 visual or layout change; it answers
the architectural question in the task title and stops there.

**Task:** *"Idea (Sam): in-app browser view — render a live localhost/URL pane
inside a pod (Widget component type?)"*

---

## The short answer to the title question

**Yes, `Widget` is the right taxonomic home — and it has no runtime today.**

`Widget` is already a declared `ComponentType` in `backend/models/Installable.ts`,
and ADR-001 §Component types describes it as `Widget { location, url, scopes }` —
which is, almost exactly, this feature. Nothing else in the taxonomy fits: it is
not an Agent, a SlashCommand, an EventHandler, a ScheduledJob, a Webhook, or a
DataSchema.

But `Installable.ts` is explicitly *"pure scaffolding: schema + types + indexes.
No services, routes, adapters."* There is no widget renderer, no widget route,
no projection, and no surface that reads `components[].type === 'widget'`. And
the Installable taxonomy refactor is **paused** under ADR-011, with a stated
reactivation trigger that this task does not meet.

So the real choice is not *"which component type"*. It is:

1. un-pause enough of ADR-001 to make `Widget` real, with this as its first
   consumer; or
2. build a one-off pane that does not go through the taxonomy, and accept that
   the second widget will have to be migrated.

(1) is the honest answer if widgets are coming anyway. (2) is defensible only
if this is a single operator affordance that will never have siblings — and the
task title's question mark suggests it is not being framed that way.

## The part that decides the feature, and it is not rendering

**An iframe runs on the viewer's machine.** That single fact splits "render a
live localhost/URL pane" into two features that look identical in a mock and
behave nothing alike:

| what the URL is | what the viewer actually sees |
|---|---|
| `http://localhost:3000` | **the viewer's own** localhost — a different machine from whoever posted it |
| a public/tunneled URL | the intended page, *if* the target permits framing |
| a Commonly-hosted URL | the intended page, always |

The `localhost` case is the dangerous one, because it **works perfectly for a
solo operator and silently shows the wrong thing to everyone else.** For Sam
alone in a pod with an agent editing Sam's dev server, an iframe of
`localhost:3000` renders Sam's dev server and looks like a triumph. The moment a
second human opens that pod, they see their own localhost — or a connection
error, which is the *lucky* outcome, because the unlucky one is that they are
also running something on 3000 and see an unrelated app presented as the
agent's work.

That is not a bug to fix later. It is the feature meaning two different things
depending on who is looking, which is the class of defect this repo's audit
keeps calling *"correct and insufficient"*.

**The remote case is bounded by someone else's headers, not ours.** Framing is
controlled by the *target's* `X-Frame-Options` / CSP `frame-ancestors`, and the
common default on anything worth embedding is `DENY` or `SAMEORIGIN`. So a
generic "paste any URL" pane will fail on a large fraction of real URLs, with no
recourse from our side. (Note the converse, checked while writing this: this
repo configures no `helmet`, no CSP, and no `frame-ancestors` — so *Commonly* is
framable. That is about us being embedded, not about us embedding, and it is
worth a separate look.)

## The reframe

The question worth answering is not *"can we render a pane"* but **"whose
browser is running it, and does the viewer see what the author saw?"**

Once put that way, a cheaper option appears that has no security surface at all
and works today: **agents already have a browser.** MCP Playwright is live on at
least one seat in this pod — verified 2026-08-25 by navigating to
`https://commonly.me` and getting a real accessibility snapshot back. An agent
can already screenshot a page and attach it.

So a first version could be:

- agent renders the page **in its own browser** and attaches the image;
- the pod shows it inline as an artifact, with the URL and a timestamp;
- a refresh action re-runs the capture.

Every viewer sees the same pixels, because there is exactly one browser and it
is the agent's. No iframe, no cross-origin question, no localhost ambiguity, no
new component type. It is strictly less capable than a live pane — not
interactive, not continuously live — and that is the trade to put in front of
Sam rather than to decide here.

## What this note does not decide

- Whether widgets are coming (an ADR-011 / ADR-001 sequencing call, not mine).
- Whether the snapshot version is enough, or whether interactivity is the point.
- Any visual or layout treatment — out of scope under the freeze.

## Open question for Sam

Which of these is the actual want?

- **"Let me watch the thing the agent is building, live, on my screen"** — that
  is the localhost case, and it is a per-viewer feature that cannot be shared.
- **"Let the pod see what the agent sees"** — that is the snapshot case, it is
  shareable, and it is buildable now.

They pull in opposite directions, and picking the wrong one costs a component
type.
