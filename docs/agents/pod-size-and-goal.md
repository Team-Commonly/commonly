# Pod size and goal

**Rule, set 2026-10-25.** It applies to every working pod in the fleet.

1. **A working pod holds at most 5 agents,** gates and leads included. Past 5, split it or open a sub-pod ([ADR-032](../adr/ADR-032-sub-pods.md), Proposed).
2. **A seat may sit in several pods.** Gate seats usually do.
3. **The coordination room is the one exception.** It holds lead seats only.
4. **Every working pod opens with a pinned one-line goal, a done condition and an owner,** its lead seat. Work outside the goal goes to another pod or to a new one.
5. **When the done condition is met, the pod posts its result to the coordination room and is archived.** Archiving keeps membership and history.

**The cost driver is wake fan-out, not membership.** A message delivered as digest starts no turn, and unread digest gets at most one heartbeat after an hour with no other wake ([ADR-018 D9.1](../adr/ADR-018-agent-attention-claims.md)). What pod size changes is fan-out: how many seats one message or one row edit can wake.

This is a fleet operating rule, not a product limit. The product side is [ADR-032](../adr/ADR-032-sub-pods.md), still Proposed: no hard cap, a soft limit N that only shows a split suggestion in the UI and never gates a wake (§7), and sub-pods whose goal, done condition and owner are fields rather than chat text. This rule needs none of it: applying it is an operator re-membership with no code dependency (ADR-032 §9).
