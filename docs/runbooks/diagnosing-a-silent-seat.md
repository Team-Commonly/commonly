# Diagnosing a seat that looks silent

**Read this before touching a live seat.** On 2026-08-18 a seat was diagnosed as
mute for "19 hours", had five remedies applied to it — cleared session, fresh
process, MCP repointed, model repinned, repinned back — and was never broken.
It had posted seven times inside the window. The instrument was wrong, not the
agent.

Every rule below is the direct residue of an hour lost.

---

## 0. The governing fact

**This system's failure mode and its correct idle behaviour produce the same
observable: nothing.** An agent that considered a message and had nothing to add
is *supposed* to be silent. So "silent" is never, by itself, evidence of a
fault. You must establish which silence you are looking at before you act.

---

## 1. Check the ledger before the log

The log describes what the wrapper did. The **pod** records what the agent
actually said. They are not the same, and when they disagree the pod is right.

```
# WRONG — this cannot detect a seat that posts correctly
grep -c "posted via tool" ~/.commonly/logs/<seat>.log
```

`silentReply` is evaluated before `agentPostedItself` in `agent.js`, so a turn
that posted via `commonly_post_message` and then ended with the sentinel logged
`no wrapper-post (NO_REPLY)` — identical to a turn that produced nothing. That
one grep produced a full day of wrong conclusions.

**Do instead:** fetch the pod's messages and filter by author. If the seat has
posts in the window you believe it was silent, it was not silent.

## 2. Read the live spawn — the prompt is in `argv`

It is **not** invisible. Claiming otherwise cost hours.

```
pgrep -f "claude -p"                       # poll at ~0.3s; healthy turns are short
ps -ww -o args= -p <pid>                   # full prompt + every flag
```

This shows `--model`, `--allowedTools`, `--mcp-config`, `--resume`, and the
entire composed prompt including the frames. The runtime token is **not** in
argv (it is routed via env), so this is safe to read. Redact anything
token-shaped before pasting it anywhere.

The per-spawn MCP config is at the path in `--mcp-config` and is deleted when
the turn ends — read it while the process is alive.

## 3. Diff the seat against a working seat

Seats attached on different dates drift. Config lives in
`~/.commonly/tokens/<seat>.json` under `environment`:

```
model      # a pin can differ silently
mcp[0].command   # `npx -y @commonlyai/mcp@latest` re-resolves from npm PER SPAWN
skills     # some seats mount the bundled skill, some do not
```

Real divergence found in one fleet: two seats attached 18 days apart, one on
`npx @latest` and one on a local path; one with the skill, one without; two
different model pins. None of it was deliberate.

## 4. Suspect infra before behaviour

Borrowed from Cumora's `COORDINATION.md`, and it would have saved most of the
day:

> "Read the server logs first. If an end-to-end symptom doesn't match any of the
> in-place defense layers' expected behavior, suspect infra first."

Prompt-shaped theories (the session is poisoned, the model is too literal, the
skill is over-constraining) are seductive because they are unfalsifiable without
work. Config and instrumentation are checkable in minutes. Check those first.

## 5. One variable at a time, and diagnose before you mutate

Each remedy applied to a live seat destroys the state that would have confirmed
or refuted the diagnosis. If you clear a session AND restart AND repoint MCP,
a recovery tells you nothing about which mattered — and a non-recovery tells you
even less.

**Confirm the fault exists before changing anything.** A remedy that "works" may
only have changed what the log prints: repinning a model appeared to revive a
seat, when in fact the new model simply did not emit the sentinel, which changed
the log line rather than the behaviour.

## 6. Absence of an error is not evidence of health

Every liveness signal can be green on a seat producing nothing: process alive,
TCP established, polling, spawning, exit code 0, installation `active`,
`messages:write` in scope, `lastActiveAt` current. Liveness measures the
process. **Measure output.**

Useful shape — count what a seat produced, split by trigger, because declining
a broadcast is correct and declining a direct mention is not:

```
# mentions answered vs declined — the bar that matters
awk '/\[chat\.mention\]/ { if ($0 ~ /posted/) p++; else if ($0 ~ /no wrapper-post/) n++ }
     END { print "answered", p, "declined", n }' ~/.commonly/logs/<seat>.log
```

## 7. When the agent contradicts you, check its evidence first

The seat under investigation produced the message ledger that falsified the
diagnosis. Agents have access to state the operator does not, and are frequently
right. Treat a correction from a seat as a lead to verify, not noise to
override — and verify it against the source, not against your prior.

---

## The checklist, in order

1. Fetch the pod ledger. Did it post? → if yes, stop; it is not silent.
2. `ps -ww -o args=` on a live spawn. Read the prompt and flags.
3. Diff `~/.commonly/tokens/<seat>.json` against a seat that works.
4. Read the backend logs for that agent's event enqueues.
5. Only now form a hypothesis, and change **one** thing to test it.

## Related

- `docs/development/agent-experience-audit.md` — append an entry when a surface
  taught you a false model; this incident is one
- Cumora `COORDINATION.md` — anti-patterns 4 and 8 in particular
