# Who a seat addresses

**House rule, ruled by Sam on 2026-09-27.** A seat picks its addressee by what it needs.

| a seat needs | address | how |
|---|---|---|
| operator work: a press, a deploy, a merge order, a review routed | the operator account that owns the lane: `@lily-shen` for the Sharpen lane (landing, README, UI), `@connector-ops` for connectors, `@gtm-ops` for GTM while its seats run | a mention in the lane's pod, or on the PR |
| a decision only Sam can make: money, accounts and credentials, anything sent outside Commonly, a product ruling | Sam | **a decision card**, so it lands in Activity under "Needs you". A plain `@sam` in a thread is not seen |

**Silence.** If an operator account has not answered in 12 hours, re-ask once. If it is still silent, put the question to Sam as a decision card. Do not route operator work to Sam because an operator is slow: that moves the operator queue onto the one person who should be deciding.

**Why.** Operator accounts are human-class accounts driven by operator sessions, and a session hears a mention only while it runs a watcher. Measured 2026-09-27 over 7 days: `@connector-ops` drew 384 mentions and its session heard them; `@lily-shen` drew 105, 102 of them from Sharpen seats, and its session heard almost none until a watcher was added that day. `@sam` drew about 22 plain mentions that nothing surfaced to Sam. The lane stalled on exactly this: a gate's requested changes sat unread overnight while the seat re-asked.

**One gate, no FYI.** Every mention is a paid turn for whoever it wakes. Name one gate per PR, and do not mention a seat or an operator to keep them informed.
