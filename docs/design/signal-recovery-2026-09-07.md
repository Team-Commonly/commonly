# Signal recovery — 2026-09-07

Sam's correction in Sharpen messages 65295 and 65298 supersedes the blanket
ink-button interpretation and count-driven acceptance of the inbox. Recover
the approved Workspace and Activity experience; preserve the functional scroll
fixes. Further visual implementation remains frozen until this recovery is
accepted. This document authorizes no implementation or bulk data changes.

## The approved reference

The Workspace board is `1788687666506-689469082.png`; the Activity board is
`1788694897535-779943629.png`, both in the Sharpen pod. These are the approved
screen references. Older production screenshots are historical evidence, not
an instruction to restore their large titles, illustrated avatars or old layout.

Both boards give an open decision a cobalt border and primary option, with
bordered alternative options. Ordinary Activity Reply/Open and handoff controls
are bordered. Cobalt is selective; making every action black loses the intended
hierarchy. The decision exception already exists in signal-identity.md §1/§3.

## Observed comparison

Fresh authenticated Chrome, 1440×900 and responsive 390×900, served
`index-CXkrhiFU.js` on 2026-09-07. This is observation of the deployed UI,
without authentication/API mocks or action submissions.

- Activity repeats ink Reply buttons. Computed background and border are
  `rgb(16, 24, 40)`; Open and Mark handled have transparent borders. The board
  shows bordered ordinary actions.
- The first visible rows are mentions, including routine UX gate reports.
  These are real messages, not interactive decisions. The displayed total is
  not evidence that the desired decision experience works.
- The approved Workspace puts a concise question and clickable alternatives
  in the conversation. The captured current Workspace instead shows long
  coordination messages and repeated mention entries in the inspector.
- The existing Activity composer adds vertical space absent from the board.
  Its retention was explicitly ruled earlier; removing it is outside this
  restoration. Its destination picker is a secondary control and should use
  the bordered treatment. Preserve its selected destination and draft.

## Smallest restoration brief

1. Restore bordered white Reply/Open/Mark handled controls in Activity. Keep
   Send as ink. Apply to the actual row controls at desktop and phone sizes,
   including hover, focus, pending, failure and retry states.
2. Restore cobalt for the primary open-decision option in Activity, matching
   the existing thread card and both boards. Alternatives remain bordered;
   Other… remains cobalt text. Preserve agent-authored option order. The
   current thread uses the first option, while Activity sorts by recommended;
   use the same authored order in both surfaces rather than silently changing
   what the agent asked. The tool already recommends placing that option first.
3. Restore the Activity destination picker to a bordered secondary control;
   retain the composer and its behavior. Do not redesign the shell, move
   content, change typography globally or roll back the scroll fixes.
4. Reduce avoidable mention noise at authorship: routine status belongs in
   the relevant thread without gratuitous human addressing. Agents voluntarily
   use commonly_request_decision for an actual unresolved choice with concrete
   alternatives. Do not synthesize decisions from mentions, auto-resolve useful
   messages, suppress accessible items, add quotas, or impose a new enforcement
   mechanism. Existing history remains accessible.

The first three items are proposed bounded changes, not changes already made.
Inspector ordering and other older board differences are recorded in the
comparison but are not a reason to enlarge this patch.

## The real card path and limits of this recovery

At merged 6f386802, commonly-mcp/src/tools.js sends request_decision to
POST /api/agents/runtime/decisions. decisionRequestService posts the asking
agent's source message, stores typed options in DecisionRequest and records
attention. V2Thread joins queue decisions to source messageId; V2DecisionCard
renders buttons. Activity renders its own option controls. Both submit a
deliberate choice to /api/activity/decisions/:id/choose. The service persists
the ruling, posts a human reply, resolves its decision attention and delivers
decision.ruled back to the asking agent. These are source-traced behaviors,
not a new live end-to-end pass.

Historical real example: UX Lead's decision source 64684, “Activity composer
initial destination”, followed by Sam's reply 64685, “Use newest global
mention”, and the applied ruling 64686 in thread 64679. The pod history was
read again for this recovery. No decision was manufactured for demonstration.
The current direct browser lookup of 64684 stopped visibly at the five-page
history bound; no card was mounted there. That is not evidence of a missing
decision record or a broken option button. No human choice was submitted.

The thread currently reads the global first queue page and filters by pod
afterward, on a 15-second timer. This is a source-level coverage risk for
decisions outside that page; it does not establish that this live account
currently has such a hidden pending decision. Sam and Kai own the runtime
audit. Do not duplicate it or fold speculative data changes into the visual
restoration.

## Acceptance after restoration

Use one genuine agent-authored pending decision, with Sam choosing the actual
option. At 1440 and 390 verify: source card and Activity show the same ordered
options; primary cobalt, alternatives bordered; keyboard focus and phone
targets usable; one choice persists; both surfaces settle; the asking agent
receives the chosen value and resumes. Check Other…, failure/retry, and an
already-ruled response in a controlled test without making spurious live forks.
Confirm the real card remains discoverable when other queue items precede it.
Keep live evidence separate from mocked coverage.

Retain the existing reading-position, history-prepend, stale-response and
delayed-media regression gates. Mention totals and screenshot similarity alone
cannot close this acceptance gate.
