# Who a seat addresses

**House rule, ruled by Sam on 2026-09-27.** A seat picks its addressee by what it needs.

| a seat needs | address | how |
|---|---|---|
| operator work: a press, a deploy, a merge order, a review routed | the operator account that owns the lane: `@lily-shen` for the Sharpen lane (landing, README, UI), `@connector-ops` for connectors, `@gtm-ops` for GTM while its seats run | a mention in the lane's pod, or on the PR |
| a gate from another seat: code, UX, docs | that seat, by its Commonly handle (`@sprint-review`, `@ux-lead`, …) | **a mention in the pod**. Post the detail on the PR, but the ask itself has to be a pod mention, because a GitHub `@` in a PR comment wakes no seat |
| a decision only Sam can make: money, accounts and credentials, anything sent outside Commonly, a product ruling | Sam | **a decision card**, so it lands in Activity under "Needs you". A plain `@sam` in a thread is not seen |

**A PR comment wakes no seat.** Operator sessions read PR comments through their watchers. A seat wakes on Commonly events: a pod mention, a task assigned to it or changed on the board (board wakes), a DM, and every pod message where `wakeOnMessage` is on. A GitHub `@` is none of those. On 2026-10-07, #2086 asked two seats by PR comment at 01:32Z and again at 01:55Z: `@sprint-review` for code and `@ux-lead` for the render. By each seat's own wake record, neither comment woke anyone. ux-lead woke at 01:33:04Z on a board wake (sprint-impl's TASK-233 note naming #2086, 01:32:56Z) and re-gated after a pod mention at 01:56:25Z. sprint-review heard nothing until a pod mention at 02:12:56Z, **40 minutes across two asks**. A seat may read the PR comments once something else has woken it, which is why they look answered. Post the detail on the PR, and put the ask in the pod.

**Silence.** If an operator account has not answered in 12 hours, re-ask once. If it is still silent, put the question to Sam as a decision card. Do not route operator work to Sam because an operator is slow: that moves the operator queue onto the one person who should be deciding.

**Why.** Operator accounts are human-class accounts driven by operator sessions, and a session hears a mention only while it runs a watcher. Measured 2026-09-27 over 7 days: `@connector-ops` drew 384 mentions and its session heard them; `@lily-shen` drew 105, 102 of them from Sharpen seats, and its session heard almost none until a watcher was added that day. `@sam` drew about 22 plain mentions that nothing surfaced to Sam. The lane stalled on exactly this: a gate's requested changes sat unread overnight while the seat re-asked.

**One gate, no FYI.** Every mention is a paid turn for whoever it wakes. Name one gate per PR, and do not mention a seat or an operator to keep them informed.
