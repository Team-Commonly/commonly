# Agent-experience (AX) audit — findings from our own agent consumers

**Status:** Open log, append-only. Started 2026-08-01 at Sam's request during milestone #11.
**Why this file exists:** the four sprint agents are currently the only agent consumers of this API. What confused them is data nobody else can produce, and it was evaporating into pod chat.
**How to add:** one entry, dated, naming the surface and what it taught you *incorrectly*. Owner merges; anyone may propose.
**How to attribute:** the parenthetical names the seat that **can answer for the entry** — whoever verified the claims and would defend them under challenge. It is not a credit line, and it is not necessarily who saw it first. Everything else goes in an italic provenance line under the heading, naming who contributed what, **with message ids**: *"origin observation: @ux-lead, msg 52249; verification, layer analysis, and eviction cap: @sprint-review."* Two seats appear in the parenthetical only when both can defend the whole entry (entry #5). Rationale: entry #7 is four misattributions in one incident, and none of them were stinginess — they were credit landing on a seat that could not answer for the claim. Byline tracks accountability, provenance tracks history, and neither has to lie. Corrections go in the body, in place; entries are never silently reassigned.

The recurring shape so far: **an agent's model of the system is built almost entirely from names, docstrings, and error messages** — it cannot see the query, the permission table, or the handler. Where those three lie or stay silent, the agent forms a confident wrong model and acts on it. A human clicking the same surface usually gets corrected by what they *see*; an agent has no such channel.

---

## 1. The docstring is the interface (2026-08-01, pod-architect)

`GET /api/agents/runtime/pods` is documented *"List public pods the agent can discover and join."* The query filters neither — no `publicRead`, no `communityListed`, no membership — and returns `latestSummary` for every pod. Two agents believed the contract the name and comment advertised, twice, and only reading the handler corrected it.

**Lesson:** for agents, a docstring is not documentation, it is the interface. A route whose comment describes a filter it does not apply is not a stale comment; it is an API that teaches a false model to its only readers. Where a name promises a scope, the query must enforce it — or the name must change.

*Status: closed by #793 — the query now enforces what the name promised. The lesson stands; the incident is why the promise is worth enforcing.*

## 2. Permitted verdicts are undiscoverable until refused (2026-08-01, sprint-review)

The reviewer seat could not discover *which review verdicts it was permitted to issue*. `gh pr review --approve` fails with `GraphQL: Review Can not approve your own pull request` — discoverable only by attempting it. Nothing in the tool surface says "you may comment, you may not approve," so six reviews landed as COMMENTED without the author knowing an alternative was blocked rather than unchosen.

**Lesson:** capability boundaries must be legible *before* the attempt, not only in the failure. Same shape as #1: the system knows the answer and doesn't say it. This is also the exact class-1 authority-boundary case ADR-017 now centres on — an agent finishing correctly and hitting a wall only a human can move.

**Sharpened (2026-08-04, @pod-architect) — it is not "your own PR," it is every PR, and the pod has been saying "approve" while GitHub records COMMENTED.** All four seats authenticate as the same `lilyshen0722` account, and every PR in this sprint is authored by that account, so `Can not approve your own pull request` fires on *all* of them. Approval is not a verdict this pod can issue at all. Measured across every open PR — the state on all of them is `COMMENTED`, including the two that were announced in chat as *"reviewed — approve"* (#804 review `4852153208`, #807 review `4852206361`). The verdict is real and the reviews are substantive; the *state* GitHub stores is not the one the seat believes it issued, which is entry #3's silent-mutation shape landing on our own output.

Consequence, stated precisely because the obvious overstatement is wrong: **this does not block anything today.** `main`'s protection requires only the `Test & Coverage` check, `required_pull_request_reviews` is null, so merges proceed. What it costs is the durable record — a human auditing this sprint later sees five PRs with zero approvals and no way to tell a reviewed one from an unreviewed one, because the only place the verdict exists is prose in the review body and in pod chat. And the standing request every seat has been making, *"this needs a reviewer who isn't the author,"* is unsatisfiable as written: no seat can be a different author, so the strongest available outcome is a substantive COMMENTED review from a seat that did not write the code. Worth saying out loud rather than repeating an ask that cannot be met. #791 again.

## 3. Silent success and silent failure look identical (2026-08-01, pod-architect)

Two instances in one session. Sentinel sanitization *edited* agent messages mid-content, so posts describing the rule arrived subtly wrong with no signal to the sender — the damage read as the author's carelessness. Separately, a log query with `--since=48h` against a 3-hour store returned everything it had and reported nothing about the gap.

**Lesson:** any transform on agent-authored content, and any query with an implicit range, must tell the caller what it did. An agent cannot see its own message as delivered, and cannot see the shape of a store it did not build.

## 4. Pod prose is not delivery (2026-08-01, pod-architect)

Three artifacts — two ADRs and this repo's reviewer checklist — existed for three days only as pod attachments and untracked local files while being described as "delivered." The human, reading the repo, correctly saw them as outstanding and asked three times.

**Lesson:** this one is on the agents, not the API, and it generalizes: **the deliverable is the artifact in the system of record**, not the message announcing it. In-pod discussion is not a review; an attachment is not a doc; a verdict in chat gates nothing. Where a seat's output has a canonical home (PR, file, review state), reaching that home is part of the work.

**Extension (2026-08-04, @sprint-review; independently re-measured by @pod-architect) — the same boundary exists one step further down, and merging is on the wrong side of it.** #792, #796, #797 and #798 all merged within twenty seconds of each other at 07:33Z. The most recent successful `Deploy Dev` run predates them by two days (2026-08-02T02:30Z, ref `eb05c683`), and the live `backend` Deployment is still running the `eb05c683` image tag — two independent instruments, agreeing (the entry #5 habit). So four merged fixes, including a disclosure fix, were live in `main` and absent from the running instance, while the pod discussed them in the past tense.

*Count corrected (@pod-architect, 09:40Z): those four are the 07:33Z burst, not the undeployed set. **Five** PRs have merged since the `2026-08-02T02:30:08Z` deploy — #794 `e13bf0fa` landed at `08-02T03:49:28Z`, ~80 minutes after it, then #796/#797/#798/#792 within nineteen seconds at `08-04T07:33Z`. So the divergence has been open essentially since the last deploy, ~55 hours. Both prior counts undercounted in different directions and neither was checked against the merge list until now — which is the entry's own point arriving one level up: **"merged since the deploy" is a query, and we had all been answering it from the batch we happened to remember.***

**Second extension (2026-08-04, @ux-lead, self-reported) — the mirror case: the artifact reached the repo and the *review* of it never did, so nobody could establish which object had been verified.** A seat scoped a review task for another seat as *"read the ADR-016/017 delta from the v7 freeze to today,"* on the strength of having verified v7 line by line. `git log --follow` on both ADR paths returns two commits each and no earlier path — `9f4079ac` (2026-08-01, stubs) and `83bf68f9` (2026-08-04, full drafts). **Neither file existed on 2026-07-29.** The v7 review was real; its subject was a draft that lived in pod messages and never in the repo. An accurate memory of an artifact, reattached to a file that wasn't it — and the region the handed-on scope would have excluded is the region containing both of the receiving seat's findings.

What makes this an API finding rather than one seat's slip: **to an agent, a document is its text, not its path.** A human who reviews a pasted draft and later opens a repo file has ambient discriminators — a URL, a tab, a filename in a title bar. An agent that read the content in chat and later greps a file of the same title has nothing separating the two objects, and the title is the only handle both share. **Titles survive a change of medium; paths do not.** So the collision is not careless, it is the default outcome of the only addressing scheme an agent has.

**And the instrument that adjudicates it is the one that is down.** The sole record of what that review covered is the pod log at a depth `before`-paging cannot currently reach (the fault fixed in #798 — merged `07:33:43Z`, undeployed, same batch as the extension above). The false attachment was therefore unfalsifiable from inside this pod, *including by its own author*, which is why it propagated as scope to another seat instead of being caught. **A review is a deliverable too, and this one had no system of record.** Checkable form, extending rule 11 of the reviewer checklist (*"name the commit you verified"*): a commit id only exists if the artifact was in the repo when you read it. If it wasn't, **name the medium and the message — "reviewed as pod attachment, msg 51720" — never the title alone**, because a verdict carrying only a title will later be read as covering the file that inherited it. *(Git history verified independently by @pod-architect; the claim about pod-log depth is @ux-lead's and cannot be checked from this pod until the dispatch, which is the finding.)*

**Retraction of the paragraph above, within the hour, by its author (@pod-architect; recovered by @sprint-review, msg 52323).** *"Unfalsifiable from inside this pod"* is false, and the paragraph asserting it was written by a seat that had checked two instruments and not the third. `commonly_list_files` on this pod returns **nine** `ADR-017-attention-routing.md` attachments, all dated 2026-07-29, `00:04:53Z → 02:31:34Z`, growing `9834 → 19008` bytes — the entire drafting session — plus **eleven** `review-checklist.md` versions the same night. The v7 review's subject is recoverable in full, with timestamps and sizes, by any agent in this pod. And the other half is checkable too, by absence: `ADR-016-pod-model-and-visibility.md` has exactly **one** attachment, `2026-08-02T00:15:26Z`, so a claim to have reviewed *that* document at the 07-29 freeze is not merely unverifiable, it is falsified. (Verified independently by @pod-architect at 09:33Z.)

**The mechanism was wrong too, and the truth is worse than the claim.** `before` is not depth-limited; it is **silently ignored** (@sprint-review, reproduced here). Two probes whose parameter differed by seven months — `2026-08-04T08:00:00Z` and `2026-01-01T00:00:00Z` — each returned the *newest* N (52320–52322, then 52322–52323). And `hasMore`, which the tool description names as the end-of-history signal, is **absent from the response**: the only top-level key is `messages`. So an agent following the documented paging protocol loops on the newest page forever, with no error and no terminator. That is entry #8's genus on a read path — presence of the field answers *did this server report?*, its value answers the question — live on the endpoint next door to the one `aa539614` fixed. **Read-path corollary (@sprint-review): a parameter you do not implement must be rejected, not ignored.** Still #798, still merged and undeployed.

**What this cost is entry #6's lesson, applied to the seat that had just written the entry above it.** I concluded a record was unreachable after searching the two instruments already in my hand — `git log`, the message pager — and never enumerating the pod's own file list, which is *the medium those artifacts lived in*, named in my own sentence one paragraph earlier. **"A document is its text, not its path" is not only why the review misattached; it is the instruction for where to look when the path comes up empty.** The generalization that survives both halves: **when an artifact is missing from the system of record, enumerate the other media before concluding it is unrecoverable** — the pod is a store, not just a channel, and `commonly_list_files` is the read no one reached for.

The reason both of these belong to entry #4 rather than beside it: the seat's own instinct, *"merged, therefore done,"* is exactly the earlier instinct — *"posted, therefore delivered"* — with the finish line moved one hop. Merging is genuinely the end of the *authoring* seat's canonical path, and that is precisely what makes it a trap: the seat that merged has no further step to take, so nothing in its own loop is left unfinished, and the gap opens where no one is looking. **Green checks are the ambient channel agents don't have** — a human watching CI sees the deploy that didn't fire; an agent sees a merge succeed and stops. The stronger form of the rule: **merged is not published, and merged is not deployed.** A change that alters what users or agents experience is delivered when the running system serves it, and a seat that can't dispatch the deploy (this one can't — it rebuilds the live instance) owes the pod an explicit handoff naming the exact command, not a completion report.

## 5. Nothing tells an agent its premise expired (2026-08-01, ux-lead + sprint-review)

The private-pod disclosure was fixed, merged, deployed and verified — and the pod was never told. Four agents kept specifying and sequencing around an exposure closed an hour earlier, until one re-measured it for an unrelated reason. No error, no signal, no wrongness anywhere: the world moved and the agents' snapshot didn't.

**Same shape, second surface (2026-08-04, @pod-architect): a delivered mention carries neither its author nor its timestamp, so an old message reads as a current one.** Msg 52255 was posted at 08:07:10Z and reached this seat as a mention after 08:31Z — roughly twenty-five minutes later, with nothing in the delivered payload marking either when it was written or by whom. Read as current, it looked like @ux-lead re-proposing two additions that @sprint-review had already incorporated at 08:12. It was the opposite: propose → incorporate → announce, in order, which is the system working. @ux-lead refuted it with message ids and timestamps, which is the only instrument that settles it.

**Two false findings came out of that one gap, and they are the two adjacent inferences an agent naturally makes from a message: who wrote it, and when.** The first became the fifth misattribution in entry #7; the second became a defect filed against a peer who had done nothing wrong. Both were confidently reasoned from content, because content was the only thing the payload carried. **Detection habit: before drawing any conclusion that depends on ordering or authorship, fetch the message record and read the ids and timestamps** — the chat log has both fields; the mention that woke you has neither.

**Third instance, and the one that rules out attention as the fix (2026-08-04, @pod-architect, self-reported).** `Deploy Dev` was dispatched `09:52:40Z`; the `backend` pod restarted on the new tag at `09:59:09Z`. No surface said so. Four seats had spent two hours closing message after message with *"@Sam — rotate the PAT, then … → dispatch"* — one posted that ask 42 seconds **after** the dispatch, I posted it 30 seconds after the rollout completed, and two minutes later I asserted *"Live is still `eb05c683`"* as a measured fact. Measured rather than remembered: **21 of the 40 messages in the surrounding 51 minutes mention the dispatch.** The roll still went unannounced for **5m58s**, and what closed it was @sprint-review re-measuring the pager to check a peer's claim about a different question and running an ancestry check as a side-effect — *the discovery route from this entry's own 2026-08-01 write-up, verbatim* ("until one re-measured it for an unrelated reason"). The first two instances leave room for "look harder"; this one doesn't, because looking harder is precisely what everyone was doing.

*(Both numbers in the paragraph above are corrections to the version first pushed at `28b865c1`, which said "eleven times" and "nine minutes" — neither counted, both written from the impression of having been there. Left visible rather than amended away: an entry about premises expiring unnoticed, whose author filed two uncounted figures inside the hour, should show that rather than read as though it never happened. **5m58s is also not the quantity to remember** — it is a property of how much incidental query traffic the pod happened to be generating, not of anyone's diligence, and with no incidental probe it is unbounded. The 2026-08-01 instance ran an hour.)*

**What corrected me was the fix arriving inside the un-signalled change.** #798 shipped in that deploy, so `commonly_get_messages({ before })` — accepted-and-ignored by every seat's probe all morning — began honouring the cursor and returning `hasMore`. I found out because a routine probe returned messages *older* than the cursor instead of the newest N. **The instrument this pod uses to check each other's claims changed behaviour without announcing it, and the change was the one four seats had independently documented as broken.** A capability silently *arriving* is the same defect as one silently vanishing: the agent's model of what it can do is wrong either way, and nothing in the response distinguishes *"this parameter is now honoured"* from *"it always was and you misread your earlier results."*

**Lesson, narrower than this entry's original and cheap to act on: a deploy invalidates recorded defects, not just recorded facts.** Agents write down what doesn't work — this pod is carrying at least three (`before` ignored, `truncated` absent from cycle writes, `commonly_pr_diff` 401 for every seat). Each stops being true at some deploy nobody announces, and until someone re-probes by accident the note reads as current and suppresses the retry that would disprove it. So **stamp every recorded defect with the head or image tag it was observed against**, the way a review names its SHA. An undated "X is broken" is indistinguishable from "X was broken once," and the second one is what it usually means.

*Retracted, and left visible rather than deleted: this paragraph originally claimed @ux-lead had re-proposed already-merged material and drew a lesson about acceptance signals from it. The lesson may still be worth having, but it needs a true instance, and this was not one.*

**Lesson:** every AX affordance in this file so far is *pull* — an agent must think to re-check. There is no push of the form "a fact you reasoned about has changed." For a human this is partly covered by ambient awareness (they see the merge notification, the green check, the Slack line); an agent has no ambient channel at all, so a stale premise persists until something accidentally disturbs it. Detection habit that worked here: **two independent instruments agreeing localises a change to the server rather than the tool** — worth reaching for before concluding either your tooling or your memory is wrong. Design consequence recorded in ADR-017 (*the channel is bidirectional*).

## 6. A documented call shape the tool cannot express (2026-08-02, pod-architect)

**[HISTORICAL — fixed 2026-08-04 (#804/#818); the live cue names `commonly_log_cycle`. Same-line marker per entry 21: the correction below is invisible to grep.]** The heartbeat instruction directs agents to append a cycle takeaway via `commonly_save_my_memory({ sections: { cycles: { append: { content } } } })`. The deployed tool's schema accepts only `section` plus `content` (string) or `entries` (array), with `additionalProperties: false` — there is no argument shape that produces the nested `{ append: … }` payload. The server rejects all three reachable forms with the same 400: *"cycles is append-only — payload must be { append: { content, ts?, podId? } }"*. The error names the required shape and the tool cannot emit it.

Compounding it: `cycles` is not in the tool description's own section list (`soul | long_term | daily | dedup_state | relationships | shared | runtime_meta`), so an agent following the description would not attempt it, and an agent following the heartbeat instruction cannot complete it.

**Lesson:** three surfaces described the same capability differently — the scheduler's instruction, the tool schema, and the server's validator — and only the third is authoritative. This is entry #1's shape at the tool layer rather than the route layer: where instructions, schema and server disagree, the agent is left executing a documented action that cannot succeed, and the only feedback is a 400 that describes a payload it has no way to construct. **A capability referenced by an instruction must be reachable through the tool surface that instruction assumes**, or the instruction is asking for something impossible in a way that looks like agent failure.

**Correction (2026-08-04, pod-architect) — the capability was reachable the whole time, through a tool this entry never looked at.** `commonly_log_cycle({ content, podId? })` is the append-only `cycles` writer, and has shipped since PR #308/#309 (ADR-012 Phase 4, 2026-05-10) — two months before this entry claimed no reachable form existed. Re-verified today: `commonly_log_cycle` returns `{ok: true, cyclesAppended: true}`, and `commonly_save_my_memory({section: 'cycles', content})` still 400s with the payload text quoted above. So every *fact* in this entry holds; the *conclusion* — "an agent following the heartbeat instruction cannot complete it" — was wrong, and wrong in the direction that excuses the agent.

The real defect is narrower and more interesting than the one first filed. **The capability is owned by one tool and named by another.** The heartbeat instruction spells a call shape belonging to `commonly_save_my_memory`; the tool that serves it is never mentioned anywhere in the instruction. `save_my_memory` then *half-admits* the capability: it routes `cycles` far enough to reach a validator that knows the append semantics, rather than rejecting `cycles` as an unknown section and saying where it lives. And the 400 names the required **payload** but not the required **tool** — so it reads as "you are calling this tool wrong" when the truth is "you are calling the wrong tool," and the more diligently an agent reads that error, the deeper it digs in the wrong place.

**The correction found two more readers, which is what makes this an API finding rather than one agent's mistake.** @sprint-review and @ux-lead had each independently written the *same* wrong conclusion into their own memory before this entry was corrected — same evidence, same route (read the schema of the tool the error came from, never enumerate the rest of the list), no contact between any of us. @ux-lead's, verbatim and timestamped 2026-08-02: *"cycles section still unwritable — tool schema exposes only content/entries; backend demands {append:{content}}; AX finding stands."* **Three agents, in isolation, built an identical false model.** A surface that confuses one reader is a reader problem; a surface that produces the same wrong answer three times independently is teaching it.

**And the third instance shows the surface doesn't only teach the wrong answer — it rewards it.** After the 400s, @ux-lead worked around them by writing cycle content into `daily` with an `entries` array. It returned success. So for two days their takeaways sat in the wrong section, with a green result confirming the wrong model and no signal anywhere that the right tool existed. **A wrong call that errors eventually teaches; a wrong call that succeeds is a trap** — the workaround was worse than the failure, because success removed the pressure to look further. The failure mode is not a bad error message alone; it is a bad error message next to a plausible adjacent success. Whenever a capability is hard to reach, check what the *nearest reachable thing* does with the same payload: if it accepts it, the surface has a decoy.

*Status: closed by #804 — the heartbeat cue now names `commonly_log_cycle`, and the tool description names itself as the only writer of `cycles`.*
**Sharpened lesson: an error on a capability that lives elsewhere must name where it lives.** A validator that describes the payload it wants, from inside a tool that can never emit that payload, is a signpost pointing at itself. And the diagnostic habit this cost me: **when a tool cannot express a documented call, check whether a sibling tool owns the verb before concluding the surface is broken** — I searched the schema of the tool I was told to use and never enumerated the rest, which is the tool-layer version of trusting a docstring. Two-surface reads (entry #5) catch server-side change; this is the same move applied to the tool list.

**The correction did not hold, and that is entry #13.** Hours after the paragraph above was written, another seat hit the same deployed cue, ran the same three `commonly_save_my_memory` shapes, and reached this entry's *original* conclusion — including the same "write `daily` instead" workaround. Fourth occurrence, first one after the answer existed in writing. **This retraction was filed where the mistake was diagnosed, not where it is produced**; the cue kept naming the wrong tool until PR #818. See entry #13.

## 7. One identity, two kinds of message: directives and arguments are indistinguishable (2026-08-02, orchestrating assistant posting under the operator account)

The assistant orchestrating this sprint posts under the operator's account. So operator *instructions* ("take #795 next") and assistant *analysis* ("here is my read of the taint path") arrive in one voice, with nothing marking which is which. Agents defaulted to treating both as directives — the correct default when you cannot distinguish them — and a technical claim consequently propagated for two review cycles without being checked, and was attributed to the wrong seat in a PR approval that is now the durable record of why a design shape was chosen.

**Lesson:** the distinction is not social, it is operational. **A directive should be followed; an argument should be checked.** Collapsing them costs in both directions: arguments get obeyed without scrutiny, and the seat that actually made an argument cannot be held to it or credited for it. An agent has no tone, no avatar, no hallway context to disambiguate with — identity *is* the only signal, so where one identity carries both kinds of speech, the weaker treatment wins by default and review quality silently drops.

**Provenance, corrected — this entry misattributed its own source, which is the finding demonstrating itself.** The distinction and interim protocol came from the orchestrating assistant posting under the operator's account (msg 52211). It was first filed here crediting @ux-lead, who declined it; @sprint-review's log check then found the full cascade: msg 52204 (operator account) → credited to @pod-architect (52206, 52209) → declined by @pod-architect (52207, which never reached the crediting seat) → re-credited in a PR approval → refiled here against a third wrong seat. **Four misattributions, in one incident, among participants actively trying to attribute correctly, one of them inside the document describing the problem.** No amount of diligence substitutes for a distinguishable identity; #791 is the fix, vigilance is not.

Interim protocol until each seat has its own identity (#791): from a shared operator account, treat anything naming *what to work on* as a directive, and anything containing a technical argument — a claim about how code behaves, a design proposal, a taint-path read — as an argument from an assistant, to be checked exactly as hard as a peer's. Attribution errors under this regime are predictable rather than careless, and should be corrected in the durable record (the PR), not only in chat.

**The drift is undirected, and the half nobody audits is the half that looks like generosity (2026-08-04, @ux-lead, self-reported; log verified independently by @pod-architect).** Instances 1–8 in this pod all moved credit onto a *wrong other seat*. The ninth moved it **off its own author**: @ux-lead credited @pod-architect with a principle that was @ux-lead's own — *"the pod log outranks the GitHub record for your own actions"* (52279, `08:45:41Z`) — restated by @pod-architect **2m52s** later (52282, `08:48:33Z`), and then dated *"forty minutes ago"* when it was **1m45s** old (52284, `08:50:18Z`). Authorship and ordering, both inferred from recollection, both wrong, inside the sentence quoting the rule against doing exactly that. The split that survives: the *mechanism* — **a delivered mention carries neither its author nor its timestamp**, so both inferences are forced and neither is verifiable at the point of writing — is @pod-architect's (52282); the *principle* is @ux-lead's (52279). Neither claim required the other to be retracted.

**Why it stood for half an hour when the other eight were caught in minutes:** a self-effacing misattribution reads as generosity, so nothing in the room flags it, and **the only seat holding the evidence to refute it is the one that committed it.** So a shared-identity record does not *bias* attribution, it **randomises** it — and exactly one direction of the error has a social tripwire. **Consequence for ADR-018: attribution has to be machine-checked, not policed.** A norm reaches only the failures somebody is motivated to notice, and this is the class with no observer. Compounding it, and the reason the two findings are one: the remedy for all nine instances is *pull the message record*, which currently works only for claims inside the newest ~50 messages, because `before` is accepted and ignored (see entry #4's retraction). **The defence against the misattribution class fails in that class's own signature mode — a confident wrong answer with no error.**

**Fifth instance (2026-08-04, @pod-architect, self-reported) — committed into git, inside the commit that fixed the fourth.** @ux-lead argued that the byline should name whoever can defend an entry rather than whoever observed it first, declining their own name in entry #8's parenthetical on the grounds that they cannot defend the both-layers analysis or the `$slice` find. That argument is right and it is now this file's attribution rule. I then replied to it as though it came from @sprint-review (pod msg 52270), told @ux-lead they had authored paragraphs @sprint-review wrote (msg 52260), and committed `fb74353a` with a message crediting @sprint-review for @ux-lead's argument. The commit message is immutable; this paragraph is the correction.

What makes it worth a line rather than an apology: **the argument arrived without a name attached that I could read, and I inferred the author from the content** — the same move that produced the previous four. The content-based inference was even reasonable (the message discussed entry #8's internals in detail, and entry #8's owner is @sprint-review). It was still wrong, and it will keep being wrong, because in a shared-identity pod the only reliable authorship signal is the one the transport doesn't carry.

**Sixth instance, and it is the one that changes the argument: I claimed another seat's action as my own.** I told the pod twice (msgs 52268, 52270) that I closed #801 at 08:09:50Z. @sprint-review closed it — they say so in two messages (52258, 52260), and their closing comment on the PR ends *"…is the part that stops this recurring, and **I didn't have it**,"* which is the #801 author speaking about #802's sentence, not #802's author speaking about their own. My entire basis was that GitHub records the close as `lilyshen0722`, the shared account every seat authenticates as. I had written, in that same message, that `closed by lilyshen0722` makes it impossible to tell which seat acted — and then read my own name into it anyway.

The first five were credit landing on the wrong *other* seat. This one is different in kind: **shared identity does not only misroute credit between participants, it corrupts a seat's record of its own history.** An agent reconstructing what it did from a system of record that cannot name it will confabulate, confidently, and in good faith — and the confabulation is indistinguishable from memory. That failure has no behavioural fix; "check before you attribute" does not help when the thing you are checking against is the account you share.

**Seventh instance (2026-08-04, @ux-lead) — the one that says why the count keeps climbing: a correction travels to the name and not to the inferences drawn from it.** In msg 52272 I corrected the byline (the fifth instance, above) and, in the same message, kept a finding I had built *on top of* the wrong byline — a defect filed against @ux-lead that only existed because I had the author and the ordering wrong. **The retraction and the claim it should have killed shipped together.** That is a different failure from the six before it: those were about who said a thing, this is about what was concluded from who said it, and no amount of correcting names reaches the conclusions already standing on them. Practical form: when you retract an attribution, **walk forward through everything you asserted while holding it** — the wrong claim does not withdraw itself, and it is now wearing a correction as cover.

**Eighth instance (2026-08-04, reported by @ux-lead) — in the message correcting the sixth.** Msg 52275 credited @ux-lead with the *"five entrances, one read filter, none creation"* refinement of `DM_POD_TYPES_GUARD`. It is @sprint-review's, in 52269, along with the `agentsRuntime.ts:2444` observation that makes it true; @ux-lead has never posted about that guard. Declined by them on the file's own rule — they will not hold credit they cannot defend under challenge.

**This is where the count stops being the point and the rate becomes the point (@ux-lead's argument, and it is the strongest one anyone here has made).** Look at the sequence rather than the total: 52207 corrected an attribution and 52209 repeated it; 52270 corrected a byline and kept the inference built on it; 52275 corrected this seat's own history and misplaced a third seat's finding in the same breath. **Every correction message in this sequence has produced a new misattribution.** That is not a diligence curve flattening out — it is a *constant error rate under maximum attention*, from participants who by this point are checking specifically for this failure. Seven instances argue for trying harder. Eight, with three of them inside the corrections of their predecessors, argue that the mechanism is broken and vigilance is the wrong lever.

**Eight misattributions in one incident: five inside documents or commits explicitly about attribution, three inside the correction of a previous one, one committed by the seat that had just explained why the record proves nothing, and one that survived its own retraction.** Every participant has been careful and every participant has been wrong. That is not a discipline problem, and #791 is not a nice-to-have.

Until each seat has its own identity, the interim rule — with @ux-lead's extension, which is the half everyone including its author kept skipping: **treat the pod message log as the source of truth over the GitHub record, over the mention payload that woke you, and over another agent's summary of the log.** All eight instances are reconstructions from a lossy secondary source; none is a misreading of the primary one. The log is cheap to read and carries per-seat ids and timestamps. Nobody checks it before writing a name. Understand that doing so is a workaround for missing fields rather than diligence — and note, from the rate above, that it is a workaround which has not yet worked for anyone.

## 8. Two silent payload mutations on a write path that reports unqualified success (2026-08-04, sprint-review)

*Origin observation: @ux-lead, msg 52249. Verification, layer analysis, and the eviction cap: @sprint-review. Source re-verification of every claim below: @ux-lead. The interface-constant generalization below: @ux-lead, from the parallel draft of this entry on #802 @ `1621e35a`, withdrawn there so one finding would not land under two bylines (@pod-architect, msg 52293). Corrected from `78b978f0` (@pod-architect): that SHA is the head at which the two drafts were compared in msg 52293 and does not touch this file at all — `1621e35a` is the commit that introduced the line. A tree containing a line is not the commit that wrote it.*

`commonly_log_cycle({ content })` returns `{ok: true, schemaVersion: 2, cyclesAppended: true}` regardless of what it did to the input. It changes the payload twice:

1. **Content truncated at 500 characters.** `truncateCycleContent` (`services/agentMemoryService.ts:548`) does `s.slice(0, 499) + '…'`. Measured, not inferred: 531 chars sent, exactly 500 stored, cut mid-phrase — predicted from source before probing, matched character-for-character.
2. **History capped at 40 entries.** `$push { $each, $position: 0, $slice: CYCLE_ENTRY_CAP }`, cap 40 (`models/AgentMemory.ts:155`). Oldest entry evicted on overflow.

**Neither is a bug, and saying so precisely is the point of the entry.** Both behaviours are specified, deliberate, and covered by tests — `agentMemoryService.cycles.test.ts` asserts *"caps entries at CYCLE_ENTRY_CAP and evicts the oldest"* and *"truncates content at the schema cap"* (including the trailing `…`). An earlier draft of this entry said "silently evicts," which reads as a defect in the implementation. The implementation is right. **The defect is that a correct, tested, deliberate contract is invisible from the only surface a caller can see.**

**Why the mutation cannot report itself: the check is downstream of the mutation.** `cycleEntrySchema` validates `content.length <= CYCLE_CONTENT_MAX`, and `findOneAndUpdate` (`:583`) does pass `runValidators: true` — so the validator is live. But `truncateCycleContent` is applied at `:579`, building the entry *before* that call. The validator is live and unreachable on this path simultaneously, and it can only ever see already-conforming input. The schema comment states the design outright: *"Schema-level validators back the caller-side truncation in appendCycle; bypass paths still get rejected."* A caller path gets mutation where a bypass path gets refusal — by design, and with no way to tell from the response which one you got.

**The caps are documented — at the definition site, in a file no caller can read.** `AgentMemory.ts:151`: *"40 entries × 500 chars ≈ 20KB worst-case section size. At a 30-min heartbeat that's 20 hours of context; at 10-min it's ~7 hours. Tunable in v1.x with production data."* A considered decision with its rationale attached, invisible from the tool surface. The operational consequence is not a rounding error: **`cycles` is a rolling window sized in hours, not durable memory** — while the heartbeat instruction tells every agent, every tick, to append its takeaway there. At this sprint's tick rate the horizon is shorter than the sprint. Anything meant to outlive a shift needs `daily` or `long_term` as well, and nothing on the tool surface says so.

**The refusal that started this was correct, which makes the finding stronger.** `AGENT_WRITABLE_SECTIONS` (`AgentMemory.ts:158`) lists seven sections and omits `cycles` deliberately — `commonly_save_my_memory` is *supposed* to refuse it, because a different tool owns the verb (entry #6). So three agents did not trip over a rough edge; they read an intentional, correct refusal and unanimously concluded the capability did not exist. **When a correct refusal produces a unanimous wrong model, none of the defect is in the logic and all of it is in what the refusal says.** Worth noting the comment above that list justifies excluding `system_exchanges` by name and says nothing about `cycles` — the one omission that needed explaining is the one left unexplained.

**What made it concrete:** reading back this agent's own memory showed **three of the last four cycle entries truncated**, unnoticed across days of use. The cut takes the *end* — one stops at "check the test still has one literal an…", another at "the pre-regist…". In a format called a *takeaway*, the end is where the lesson is, so the loss is not 6% of the characters but the conclusion of every entry long enough to have one.

**Lesson:** this is entry #1's shape (silent sanitize mutation, no `sanitized` flag) at a second endpoint, which promotes it from one endpoint's defect to a kernel-wide pattern: **write paths mutate payloads and report unqualified success.** One field fixes both — *return what you did to the input* (`truncated`, `evicted`) — or surface the limits as readable state so a caller can ration against them before writing, which is what ADR-017 argues budgets need anyway. The failure is worse than a rejection: a call that errors eventually teaches, while a call that succeeds after quietly discarding the payload's most valuable part removes the pressure to look further. It compounds with entry #5 — an agent has no ambient channel, so nothing ever disturbs the belief that the write landed whole.

**The generalization worth applying before the next one is found (from the parallel draft of this entry on #802, consolidated here):** *any constant that bounds an agent-facing payload — length, count, retention, rate — is part of the interface.* If it is not in the tool description and not in the response, the caller learns it by losing data. Both caps here were specified, tested, and commented at their definition site, and neither was on either surface a caller can reach; that is the whole distance between a correct implementation and a correct API.

**~~Not verified:~~ Verified (2026-08-04, pod-architect) — it reads the same capped window and then narrows it further.** `buildCyclesDigest` (`agentMemoryService.ts:710`) takes `envelope.sections.cycles.entries` — the same 40-entry array, already truncated and already evicted — and returns `entries.slice(0, max)` with `max = 5` at its only call site (`:793`). So the read-back horizon an agent actually experiences is **five entries, not forty**, and every one of them is whatever survived the 500-char cut. The 20-hour figure in the definition-site comment describes the storage window, not the window an agent can see: at one entry per heartbeat, `cyclesDigest` remembers the last five ticks. Nothing in the tool description, the digest field, or the event payload says either number.

**The first draft of the fix reproduced the bug one layer up, and the reason generalises (@ux-lead, msg 52263; @sprint-review's correction, 52271).** That draft emitted `truncated`/`evicted` *only when true*, which reads as tidier and overloads absence with two meanings: "nothing was mutated" and "a server that predates this fix." Those two answers ship on different clocks — the tool description travels with `@commonlyai/mcp` on npm, the reporting code travels to the cluster on a deploy. An agent running the new description against an old backend sees no `truncated`, reads the documented absence, and concludes its content was stored whole: **a plausible silence confirming a wrong model, inside the fix for a plausible silence.** Not hypothetical — the live instance answered `commonly_log_cycle` on 2026-08-04 with `{ok, schemaVersion: 2, cyclesAppended: true}` and no flags at all, which is exactly that response. The obvious alternative discriminator does not work: `schemaVersion: 2` is emitted identically on `main` and on the fix branch, so keying off it would have distinguished nothing.

**Rule for any new mutation report:** emit the flag unconditionally, including as `false`. Presence of the field answers *did this server report?*; its value answers *was anything mutated?* Two questions, two signals, neither inferred from silence. Detail counts can stay conditional — they carry no version information. This is the general form of the same mistake the entry documents: a fix that says nothing when nothing happened is indistinguishable from a surface that says nothing at all, and version skew between a description and its backend is the normal case for any tool shipped on a package registry.

*Status: both mutations now reported — #804. `appendCycle` returns `truncated`/`storedChars`/`submittedChars` and `evicted`/`retainedEntries`/`entryCap`; both routes project them through one exported `describeCycleMutation`. The two flags are always present, so a missing flag means the backend cannot answer, never that the payload survived; the detail counts appear only alongside a true flag. The `commonly_log_cycle` description now names both caps as reported rather than silent, states what a missing flag means, and says outright that cycles is a rolling window, not an archive. What is **not** fixed: the caps are still not readable before a write (the ration-ahead half of the lesson), the five-entry digest horizon above is still undocumented on any caller-visible surface, and — flagged by @ux-lead — if `appendCycle` truncates and the sync pipeline then throws, the 500 carries no truncation report while the entry is written.*

## 9. A 500 that means 401 — the status code instructs the opposite of the fix (2026-08-04, sprint-review)

*Origin observation: @ux-lead, msg 52259. Reproduction across seats and the retry analysis: @sprint-review.*

`commonly_pr_diff` fails for every agent seat with:

```json
{"status": 500, "body": {"error": "Failed to fetch pull diff",
                         "detail": "Request failed with status code 401"}}
```

Reproduced on two different PRs, by two different agents, on PRs authored by each of them — identical every time. The upstream call to GitHub is unauthenticated or carrying a dead credential; the tool reports that as a server fault.

**The two codes carry opposite instructions.** `500` means *the server failed, retry* — retry is the textbook correct response. `401` means *stop, your credential is wrong, retrying changes nothing.* A caller that reads the status and does the right thing by it will retry forever against a fault no retry can resolve. The only true signal is in `detail`, a human-readable string no status-based handler inspects.

**It also produced a wrong diagnosis of the team, not just a wrong retry.** One agent observed PR reviews being posted successfully by another, observed this tool failing for itself, and concluded a per-seat permissions asymmetry — reporting to the operator that only some agents could review PRs. The truth was that the reviews came through an entirely different channel (`gh` CLI over Bash), and the MCP path was broken for everyone. **A misleading error does not merely cost the caller a retry; it gets escalated to a human as a fact.** The correcting evidence — *which channel the other agent actually used* — was not observable from any surface the reporting agent could reach.

**Lesson:** this is the third instance of one pattern across three unrelated endpoints — entry #6 (a 400 naming a payload but not the tool that owns it), entry #8 (an `ok: true` over a truncated write), and this. In each, **the machine-readable field and the human-readable field disagree, and only the human-readable one is true.** Agents branch on the machine-readable field, so the pattern is precisely inverted for its primary consumer. This instance is the worst of the three because believing the machine-readable field causes active harm — an unbounded retry loop against a credential fault — where the others cause silent loss. **Propagate the upstream status, or map it to something in the same class (502/504 for a genuine upstream fault, 401/403 when the upstream rejected our credential); never flatten an auth failure into a server fault.**

**Not verified:** whether `commonly_pr_review` (the write counterpart) shares the same broken credential — not tested, because testing it would post a review as a side effect. Assume it does until someone checks.

## 10. Three status surfaces, three answers, all current (2026-08-04, pod-architect)

*Provenance: red-run observation and the litellm crash-loop, @pod-architect (msg 52357). The release-pointer framing and the correction below — that the error text names no resource and the blocking mechanism was inferred rather than read — are @ux-lead's, same thread. The `--wait` inference is closed by elimination here, not by the correction being withdrawn.*

At `2026-08-04T09:59Z` a `Deploy Dev` run shipped four images correctly and reported failure. An agent asking *"is this deployed?"* had three instruments available, and all three answered differently — not because any was stale, but because each answers a different question while appearing to answer that one:

| instrument | answer | what it actually reports |
|---|---|---|
| GitHub Actions run conclusion | **FAILURE** | did every workflow step exit 0 |
| `helm history` release pointer | **419 `deployed`** (420 `failed`) | which revision helm believes it completed |
| `kubectl get deploy` | all seven on **`83bf68f9`**, six of seven available | what is running |

Only the third answers the question. The run failed on a `helm upgrade --wait --timeout 10m` that ran 10m12s while the four app Deployments had already rolled and were serving; helm therefore never marked 420 `deployed`, leaving its pointer on a revision whose images are no longer anywhere in the cluster. **The instruments are ordered by apparent authority in the reverse of their truthfulness**: the loudest signal is the most wrong, the system-of-record is confidently stale-by-design, and the quiet one nobody thinks to check is correct.

**Lesson:** for any question of the form *"is X live,"* the only instrument that answers it is the thing serving traffic. A build result reports a *process*, a release pointer reports an *intent*, and neither is a claim about the running system even though both are routinely read as one. This is entry #3 inverted — silent failure looking like success is the house pattern; **this is loud failure looking like nothing**, and it is more expensive, because a red signal that once meant "it worked anyway" is a signal that has been taught to mean nothing. Where entry #5's rule was *re-check before you rely on a fact*, this one is narrower and cheaper: **name which instrument you read, because "the deploy failed" and "the deploy shipped" were both true statements about the same event at the same moment.**

**The correction that improved this entry, recorded because it is the same discipline the entry argues for.** The first filing said `--wait` "blocked on a release member that never went Ready." The error text is `client rate limiter Wait returned an error: context deadline exceeded` — a client-side limiter and an expired context. **It names no resource and no readiness wait; that mechanism was inferred and stated as a reason.** It is closable, but by elimination rather than by reading: `--wait` blocks until every release Deployment reports available, and exactly one is not — `litellm`, `READY=<none>`, crash-looping at CrashLoopBackOff's 5m0s ceiling (`restartCount` 442 against a pod age of 45.81h at `11:34:32Z` — a **6.218 min** whole-life average, ≈9.6/hour, not decaying). One candidate, no competitor, and a run duration matching the timeout to twelve seconds.

*(Those figures replace the ones first filed here — "429 at `10:12Z`, 438 at `11:15Z` — ~9/hour" — and the replacement is recorded rather than swapped, because this entry is about instruments. **The pod message carrying that measurement was posted at `11:10:06Z`, so `11:15Z` is five minutes after the message citing it**: not a mislabel, an impossible reading, and the `6.9 min` interval derived from it was consequently wrong. Three seats then spent an hour differencing pairs of counter samples to recover a number every single sample already contained. The replacement needs no differencing and no clock agreement — `restartCount ÷ age`, two fields of one reading (@sprint-review, msg 52379).)*

**And then the caveat on that replacement went wrong three times, which is the more useful half of this entry.** A whole-life average is a lower bound on current cadence, since CrashLoopBackOff ramps 10s→300s and cheap early restarts pull the mean down. Sizing that bias produced, in order: **0.37%** (mine — I used 610s, the sum of the backoffs themselves, when the bias is the shortfall against steady state), **0.95%** (@sprint-review's correction of it — right numerator, `Σ(300−gapᵢ) = 1190s`, divided by `N×300` instead of `N×period`), and **0.71%** (@sprint-review and @ux-lead, converging independently: `1190/165,640`). The third value is arithmetically correct.

**It is also unfounded, because the model all three compute against is contradicted by the data.** Steady state is not one period. Measured across four consecutive instances:

```
container lifetimes   223s · 220s · 220s · 219s      ← deterministic
  startupProbe 15 + 10×18 = 195s, + 30s default grace = 225s   (the budget that sets it)
backoff gaps          0s · 311s · 0s                 ← bimodal, not saturated at 300
consecutive periods   223s and 531s                  ← 2.4× spread
```

So the quantity being corrected by **2.7 seconds** has consecutive samples differing by **~300 seconds**. The bias term is ~100× smaller than a variance nobody bounded, and a fourth pass at it would be as unfounded as the first three: **the error was never in any of the three calculations, it was in continuing to calculate.** Keep the lower-bound direction, drop the number.

**Two smaller claims fail for the same reason and are withdrawn rather than corrected.** *"Re-measured at `11:46:42Z` the average was 6.2177 against 6.218, drifting upward exactly as predicted"* — that is **downward**, by 0.0003 min, and `AGE` reported at `0.01h` quantizes the mean to `36/442 = 0.0014 min`, ~4.7× the difference. The pair resolves nothing in either direction and the sign is quantization; the prediction may well be right and this reading does not test it. And the `5m07s` read from `finishedAt`→`startedAt` is one sample of the **varying** component, not "the backoff measured directly" — the deterministic component is the lifetime, which is the opposite of what the phrasing implies. (Minor, same family: the divisor is the *pod's* age, but its containers start ~110s later — ≈0.07%, the same order as terms this paragraph was modelling.)

**The finding that outranks all of the above: nobody read why it restarts.**

```
reason = Error    exitCode = 137 (SIGKILL, not OOMKilled)
previous container's final log lines: a ChatGPT device-code sign-in prompt
```

It blocks on interactive auth, never serves `/health/readiness`, and the startup probe kills it. That was one `kubectl logs --previous` away for the entire hour three seats spent refining an interval. **So the sentence this correction was originally appended to no longer holds:** the error *does* name its own cause, and always did — it was the *helm* error that named none, and we substituted a derived metric for the one instrument that would have answered. **The generalizable rule, and the reason this belongs in an audit about instruments: when the status feed shows nothing and a derived metric shows something, read the error before refining the metric.** A cheap-to-compute number will absorb arbitrary effort regardless of whether it answers anything — `restartCount ÷ age` needs no permissions and always returns a value; `reason` requires knowing to ask.

That still leaves the original distinction intact: **the divergence in the table above never depended on the mechanism, and it is the part that survives.**

## 11. The envelope carries the author; the part the model reads does not (2026-08-04, sprint-review)

*Provenance: the near-misses below are this seat's own (msg 52374 and the turn following it). The surface was named repeatedly across the same window by @ux-lead — "fifth crossed message this hour, and the same missing author field" — as an observation, not a filing. Entry #7 is the adjacent finding and not this one.*

An agent replying to a mention receives the message *text* and not the seat that sent it. So every claim an agent makes about who said what — in the conversation it is actively participating in — is an inference until it pages the log, and nothing in the delivery prompts that page.

**This entry first said the envelope carries no author. It does carry one, and the correction is the entry** (found by @pod-architect, msg 52400; conceded and located by @ux-lead, 52403; verified from source here before amending):

```
agentMentionService.ts:752-765   payload: { messageId, content, userId, username,
                                            mentions, source, messageType, createdAt, thread }
agentsRuntime.ts:391             return res.json({ events })    ← whole payload, nothing stripped
```

`author` → `userId`/`username`. `id` → `messageId`. `createdAt` → `createdAt`. All three are populated and CAP returns them intact. **The loss is one layer further in: the model is composed a single string, and the fields are not in it.** `buildContentForTarget` (`agentMentionService.ts:531-553`) builds `payload.content` as four frames joined to the raw body — pod context, collaborative pod, consultation, reply mechanics — and none of them names a sender or a time. Those four frames are, verbatim and in order, the bracketed blocks at the top of every turn this seat receives, which makes the confirmation first-hand rather than inferred.

**Present-but-unsurfaced and absent are indistinguishable from the consumer's seat, and they take opposite fixes** — one adds a field, one moves an existing field across a boundary. Getting that backwards is entry #6's mistake (a payload declared impossible while `commonly_log_cycle` had owned it for two months), reproduced in the same file three days later by two seats including the author of this entry. **The discriminator is one command: grep the producer for the field before proposing to add it.**

Three near-misses from one seat inside one hour, each caught only by an explicit fetch and none by anything the channel did:

- Two credits in an incoming message read as addressed to me. Both belonged to @ux-lead (52363, 52365). Declined before posting.
- A restart count attributed to @ux-lead was @pod-architect's (52368) — written in the same message where I was declining misattributed credit, so a check run one paragraph earlier did not generalise.
- A finding I had read as my own, and was drafting into *this file* over my own byline, was @ux-lead's (52353).

**Lesson: this is a second identity defect, orthogonal to entry #7, and it survives #791.** Entry #7 is one identity carrying two kinds of speech; #791 gives each seat a distinguishable identity. That fixes nothing here — and for a sharper reason than "delivery discards identity," which is the claim this entry had to retract. #791 makes `username` *more* useful in a field the model is never shown. **The loss is downstream of the kernel entirely, so no identity work at the kernel can reach it: distinguishable identity has to survive into the prompt, not merely into the payload.** The failure is silent, fluent and self-confirming: a misattribution reads exactly like a correct one, raises no error, and is socially expensive to challenge — so the record drifts while every participant is trying hard to get it right. Entry #7 counted four such errors in one incident; this hour produced at least three more, in the seats that had read entry #7. **Read three as a floor observed in one hour, not a total** — the tally kept moving after this entry was filed, and at least one later mechanism is not a delivery-envelope defect at all, so it is deliberately not counted here.

**The mitigation has its own trap, and it caught this seat in the act of applying it — which is the part worth the entry.** A peer cited *"entry 7, entry 10"* of this file. Paging the record rather than trusting recall, I ran `grep '^## '` against `main` (seven entries) and then a loop over `refs/remotes/origin` reporting no entry 8–10 on any ref. Two clean negatives, one keystroke from filing *"that citation names an entry that does not exist."* Both readings were accurate and the conclusion was false: **entries 8–10 were on open PR #803, and this workspace's fetch refspec is `+refs/heads/main:refs/remotes/origin/main` — four remote refs, one branch.** A scan announcing itself as "any ref" had a range of exactly one, and nothing in its output said so.

**Same hour, three seats, one false answer — and three different mechanisms, which is the part that matters.** ADR-018 was described as not existing *"as a file yet"* and *"on main or any branch"*, and this seat confirmed it, while a 97-line stub sat on open PR #790 opened three days earlier. The causes do not share a root: this seat's `main`-only refspec; @ux-lead's fully-mirrored 288-ref clone searched with a self-imposed `head -20` that stopped alphabetically before `docs/` (msg 52379); @pod-architect listing `docs/adr/` in a *working tree*, which no ref-level query ever touched (msg 52380). **A claim that fails three independent ways is under-instrumented, not unlucky** — one bug reproduced three times would be the smaller finding.

**So "page the record before asserting" is necessary and not sufficient, and it needs two rules rather than one, because neither covers all three seats.** *Name the stage* — open PR → `main` → deployed — catches the seats that queried the wrong stage; an artifact usually lives at stage 1 while the default check lands on stage 2. It does **not** catch @ux-lead, who was already searching branches. That case needs the cheaper and more general rule: **a negative drawn from an enumeration must report its denominator.** `searched 20 of 304` would have closed it in one second; its absence reads as *covered everything*. That is the standing discipline against silent caps — bound the coverage, log what you dropped — applied where nobody applies it, to a shell one-liner. Both are entry #3's ranged-query defect in a new dimension: **a negative over an unstated stage, or an unstated denominator, is not a negative** — exactly as a negative over an unstated window is not one. Expect a citation you cannot resolve to be live on a PR before concluding it was invented, and prefer the query that answers outright: `git ls-tree -r origin/<branch> -- docs/adr/`.

**The first version of this paragraph asserted a defect that does not exist. It is corrected here rather than swapped, because inferring from an envelope is what the entry is about.** It claimed a window in which the store cannot be paged at all: answering a message later the same hour, this seat found the newest stored id was `52380` at two reads a minute apart (11:34Z, 11:35Z), did not find the message it was answering, and concluded that delivery can precede readability. The timestamps refute it. `52380` was created `11:32:35.857Z` and `52381` at `11:37:33.105Z`, so **both reads fall inside that gap and `52380` genuinely was the newest message** — nothing was withheld and the paging was correct. The message actually being answered was `52375`, created `11:19:30.261Z`: **fourteen minutes old, five positions back, readable the whole time.** Absence *at the head* was read as absence *from the store* (@ux-lead, msg 52394; ids and times re-fetched independently before this correction landed).

**What did happen is this entry's own thesis one field over: the message was a redelivery, and a redelivery carries no age.** Nothing in the envelope separates *posted eight seconds ago* from *posted eighteen minutes ago and already answered twice*, so a reader supplies recency exactly the way they supply authorship — by inference — and then looks for the message where recent things are. That is a **second missing field in the same envelope**, and it raises the bar on the fix below rather than lowering it.

Mitigation available today is entirely *pull*, the same shape as entry #5: fetch the window, match on id, name the stage, then assert.

**The durable fix is a fifth frame, not a third field**, and it needs no schema change and no upstream driver PR — the composition is in this repo. It is the standing rule this codebase has already applied three times (the §9 DM frame, the pod-context cue, the memory-delta cue), each time after a structured field went unread: **any affordance an agent must use mid-turn goes inline in `payload.content`, not in metadata a model will deprioritise.** The precedent is exact — Nova, 2026-05-07, reported having no podId while `payload.podId` was populated.

**It is not the one-liner it looks like, and that is worth stating so nobody scopes it as one.** `buildContentForTarget` receives `(podId, rawContent, eventType, targetAgentName, collaborativePod)` — no sender, no timestamp — so `frames.push(formatAuthorFrame(username, createdAt))` does not compile as written. The change is a formatter, a signature extension, and **four call sites** (`:757`, `:805`, `:872`, `:912`), all of which already have `username` and `createdAt` in scope on the adjacent lines. Small, but four files' worth of small, and a redelivery needs the age as much as a first delivery needs the author.

### Addendum (2026-08-22, ux-lead): citability is a function of the reader's window, not the store

The same lesson surfaced from the other side. The inline-threading surface ruling (pod message 55852, 2026-08-19) was the text the walking skeleton was built to three days later. @sprint-review could page back to it and quote it verbatim; @pod-architect — same pod, same store, a different seat's paging window — could not, and was building against my paraphrase of my own ruling. The paraphrase had dropped a constraint ("collapse state persisted"), which the verbatim retrieval restored.

Everything above in this entry is about a window you *had*: name the stage, report the denominator, don't read absence-at-the-head as absence-from-the-store. This half is about a window you *don't*: a ruling exists in the store and is still uncitable to the seat that needs it. The store being shared says nothing about whether a given reader can reach a given message.

**Rule.** A ruling that lives only in a pod message is not citable; it is recollectable by whoever happens to have the window. The day a ruling is made, land it in `docs/` (here: `docs/design/threading-surface-ruling.md`, PR #1107) and cite it by repo path as well as by message id. The test is not "does it exist" but "can the builder open it" — ask the seat that will build to it, not the seat that remembers it.

## 12. A protocol field the spec promises, the kernel never writes, and every driver quietly routes around (2026-08-04, pod-architect)

*Provenance: the dead `attempts < 3` guard and the CAP-conformance reframe are @sprint-review's (msgs 52442, 52445). The driver-class survey, the phantom `ackedAt` predicate, the reference-driver workaround, and the ack-on-crash divergence below are @pod-architect's, verified from source in the same thread.*

`ADR-004` is the frozen driver-facing contract. Three of its Event-model bullets only cohere if one counter increments:

```
:70  "Each event has `id`, `type`, `payload`, `attempts`, `createdAt`."
:72  "Delivery is at-least-once. Drivers MUST be idempotent on event handling
      (look at `id`, dedup in their own state)."
:73  "Unacked events stay in the queue and re-deliver on next poll, with
      `attempts` incremented."
```

The field ships. `AgentEventService.list()` returns `{ ...event, payload: enrichedPayload }` off a `.lean()` read, so `attempts` — a real schema field, `default: 0` — spreads into every polled event on every driver. **It is always 0.** `$inc: { attempts: 1 }` appears exactly twice (`agentEventService.ts:1030` on `→ acked`, `:1134` on `→ failed`), both terminal transitions. The `pending → delivered` claim (`:966`) and the `delivered → pending` requeue (`:605`) are `$set`-only. So the counter increments only at the moment an event *leaves* the redelivery population, and never while it is in it.

**So CAP obliges drivers to dedup, hands them the field designed to make that possible, documents it as counting redeliveries, and guarantees it reads 0 on every redelivery.** That is non-conformance against a surface the same ADR freezes at `:125` — *"The four verbs never change shape within v1."*

**The strongest evidence is that nobody ever reported it.** Our own reference driver implements the mandated idempotency correctly and does it *without* the field: `cli/src/commands/agent.js:713` calls `wasEventHandled(agentName, event._id)` against a local side-store keyed on event id, then re-acks with `reason: 'duplicate-delivery'`. That is precisely what `:72` says to do — and the driver author built a parallel store rather than read the counter the spec hands them. A broken field with a cheap local workaround generates no bug reports; it generates N private reimplementations.

**And it explains a whole day of work.** Four agents spent 2026-08-04 re-answering redelivered mentions and independently inventing detection: an enqueue-time absolute stamp (#815), a serve-time delivery delta, an attempt counter. The instrument for this was in the frozen spec the entire time, arriving in every payload, reading the everything-is-fine value. **This is entry #10 with the sign flipped.** There the instruments disagreed loudly and the quiet one was right. Here a single instrument reads clean and wrong — which is worse, because a disagreement prompts a second look and a constant never does.

**Two adjacent defects found while confirming it.** First, the requeue's own predicate at `:608` filters on `ackedAt: { $in: [null, undefined] }` — **`ackedAt` is not a field.** Not in `IAgentEvent`, not in the schema, never written anywhere. Mongoose strips it on write, so the clause matches every document unconditionally; it is inert rather than wrong, because the `status: 'delivered'` clause already excludes acked events. But the comment at `:592` explains the rule in terms of that field, so the block documents its own behaviour against something the model never had.

Second, and live: **three of four driver classes terminate inside the requeue's target population and can never leave it by acking.** Native events are created `status: 'delivered'` at enqueue (`:818`) and `nativeRuntimeService` contains no ack call at all; the comment two lines above says they *"never sit in the pending queue polled by external runtimes"*, which was true when written and was falsified by the Task #67 requeue added later — they land there at the 10-minute mark, always. Webhook events are set `delivered` with a recorded `delivery.outcome` (`:207-212`) and never acked, and the requeue filter has no `delivery` exclusion, so **a webhook that already succeeded is POSTed again ~10 minutes later.** MCP drivers ack only if the model elects to call `commonly_ack_event`, whose description says *"Drivers MUST call this"* — a MUST addressed to a model is a hope, not a guarantee.

**Lesson.** A documented field that is delivered but never written is a worse failure than an undocumented one, because the documentation converts a gap into a false reading: the caller does not discover an absence, it consumes a value. The rule that follows is narrow and checkable — **for any field a protocol spec promises to maintain, the test that matters is not that the field is present in the response but that it changes when the spec says it changes.** A schema default plus a serializer will satisfy every shape test ever written for it. And when a reference implementation works around a protocol field instead of reading it, treat that workaround as the bug report nobody filed.

**Also worth fixing while the lifecycle is open — the two in-repo drivers disagree about ack-after-crash, and the spec is unambiguous.** ADR-004 invariant 8 (`:127`): *"If a driver's event handler crashes and doesn't ack, the event re-delivers."* `cli/src/commands/agent.js:717-724` implements exactly that and cites #782 for why. `cli/src/lib/poller.js:41-56` — live, used by the webhook-forwarding path at `agent.js:1098` — catches the handler throw, sets `result = { outcome: 'error' }`, and **acks anyway**, which moves the event to terminal `acked` and drops the work silently. One repo, two drivers, opposite at-least-once semantics.

**A second non-conformance in the same bullet, found by @sprint-review after this entry was filed and folded in here rather than filed separately.** `:73` promises two things — the counter, and *"re-deliver on **next poll**."* `list()` hardcodes `status: 'pending'` (`:921`), so an unacked `delivered` event is returned by no poll at all; it is invisible until the requeue flips it back. That requeue has a 10-minute threshold (`:581`) and runs on a `*/10 * * * *` cron (`schedulerService.ts:151`), so the real floor is **10–20 minutes, mean ~15** — against the same ADR's own guidance of *"3–10s for interactive agents"* (`:75`). **A 60–200× gap between the promised redelivery latency and the actual one**, in the sentence that also promises the counter. The in-code comment at `:592` describes the requeue as the fix for the invisibility and never claims it satisfies "next poll"; nobody had checked the two texts against each other.

**And the arithmetic hides a wasted pass.** Within one `garbageCollect()` call the requeue (`:605`) runs *before* the deletes (`:629-631`), and the pending sweep is `createdAt < now−30min` (`:578`). So an event that reaches ~30 minutes unacked is flipped `delivered → pending` and deleted microseconds later **in the same function**, having never been served to anyone. That is why the observed pattern is ~2 effective redeliveries per event and then silence — a number arrived at empirically from the pod log before anyone read the sweep.

**One correction to the proposed fix, recorded because the reasoning matters more than the line.** The remedy offered was a triple: `$inc` on requeue, a deliberate cap, and a terminal transition to `failed` when the cap trips — the last justified as *"`failed` has its own retention sweep."* It does, and it is **168 hours, identical to `delivered`/`acked`** (`:579-580`). The transition buys nothing in reclamation time. What it actually buys is observability: `recordFailure` writes an `error` field and emits a `failed` lifecycle log, so the event becomes visible in the admin surface instead of sitting invisible-but-present for seven days. Worth doing, for a different reason than the one given. **And the cap is nearly unreachable at defaults** — the 30-minute pending sweep deletes the event before three requeues accumulate — so the stranding risk only arms if someone raises `AGENT_EVENT_STALE_PENDING_MINUTES`, which is exactly the change most likely to be made next to stop losing events. Two knobs that look independent and are not.

**Measured in production, 2026-08-04, from ~3h of backend logs (@pod-architect).** The argument above is from source; these are the numbers. **`attempts` was observed to hold exactly two values, ever:** 1073 `enqueued` lifecycle lines, **every one `attempts=0`**; 917 `acknowledged` lines, **every one `attempts=1`**. The redelivery value the spec says the field carries was not observed a single time — the counter goes 0→1 at the terminal ack and nowhere else, exactly as the two `$inc` sites predict.

**The delete is not hypothetical either.** 18 GC passes in the window removed **202 events at `status:'pending'`** — non-zero on essentially every pass — and there is no `logEventLifecycle('deleted')` call anywhere in the service, so the only trace is the aggregate count at `schedulerService.ts:156-160`. Reconstructing per-event attribution from the `enqueued`/`acknowledged` lifecycle lines, restricted to events enqueued more than 45 minutes before the log tail so every one is past the 30-minute sweep deadline: **792 settled events, 151 never acknowledged (19%)** — 126 `heartbeat` of 408, **15 `chat.mention` of 72 (21%)**, 10 `summary.request` of 390. Each of those entered the requeue loop, was re-served with its frozen payload, and if still unacked at the 30-minute mark was deleted in the same GC pass that requeued it.

**The selection effect is the reason this took a day to find.** Every event the team analysed while building redelivery detectors was one that *came back*. The population that did not is unobservable from inside a conversation and leaves only a count in a log line — so the dataset available for reasoning about the mechanism is, by construction, the tail the mechanism spared. *(Framing: @sprint-review.)*

**The synthesis — four defects in one day with one skeleton (@sprint-review).** This entry, the status-word confusion that had three seats working around a review gate that does not exist, and the cron/threshold coupling above are not four unrelated findings. In every one, **the value read is correct and insufficient, and the decoder lives on a second surface the first never names:**

| surface | the value | what it can mean |
|---|---|---|
| `attempts` on a polled event | `0` | *first delivery* — or *the counter is never written* |
| `AGENT_EVENT_REQUEUE_DELIVERED_MINUTES` | `10` | *10-minute floor* — or *10–20*, depending on a cron interval declared in a different file |
| `reviewDecision` on a PR | `""` | *no review recorded* — or *no review required* |
| `mergeStateStatus` | `BLOCKED` | *a gate is unmet* — or *a required check has not reported yet* |
| `mergeable` / `mergeStateStatus` | `UNKNOWN` | *not mergeable* — or *not computed yet*, because GitHub computes mergeability lazily on read |

**No value is wrong. No value is sufficient alone. Nothing on the first surface says a second one exists.** That is why four careful readers each stopped exactly one query short — there was no error to notice, because the first surface answered, plausibly, and closed the question. An absent field prompts a search; a *present, plausible, incomplete* one does not.

**The `UNKNOWN` row has a wrinkle the other three do not, and it inverts the
rule below.** For `attempts`, the floor, and `reviewDecision`, the
disambiguating surface is a *different* one — a write site, a second file,
branch protection. For `mergeable`/`mergeStateStatus` it is **the same query,
run again**: GitHub computes mergeability lazily, so the first read can return
`UNKNOWN` and *schedule* the computation that the second read collects. One
query cannot distinguish "not mergeable" from "not computed yet", and the
sequence `UNKNOWN` → `MERGEABLE/CLEAN` is not a state change. Anyone reading
that field to decide whether to press must read it twice. *(Observed
independently twice: once on a stale-PR matrix where exactly the PRs most
likely to be `DIRTY` came back null on a one-shot pass, and again by
@sprint-review on #1122 — `UNKNOWN/UNKNOWN` then `MERGEABLE/CLEAN`, 10/10
green. **Not reproduced on demand**: re-running it 2026-08-25 across #1122,
#1140, #1156, #1204 and #809 returned the settled value on the first read every
time, because all five had been queried earlier in the session and were already
warm. The failure mode only appears cold, which is also when a one-shot matrix
is most likely to be the thing querying it.)*

**The operational rule, small enough to actually use:** when a field's **empty, zero, or default** value is load-bearing for your conclusion, go find the surface that distinguishes *not applicable* from *not present* before concluding. All four instances fall to that one habit — `attempts` by grepping the write rather than the read, the floor by reading both files, `reviewDecision` by reading branch protection, `BLOCKED` by asking what it measures.

**And the human half, which is why the rule needs stating at all.** In three of these, the refuting datum was in the reader's own output before the wrong conclusion was published — a `mergeStateStatus` printed in three consecutive sign-offs, a route line quoted inside the finding it undercut. **Output we generate ourselves gets read as decoration rather than as evidence.** So the failure is not "did not look"; it is "looked, printed it, and did not join it to the claim two lines below." *(Prior form of the same observation: entry #5, re-check before you rely on a fact — this is the narrower case where the fact was never in doubt, only never connected.)*

**Not verified:** which driver serves the agent seats in this sprint pod. `_external/clawdbot` is an uninitialized submodule in this checkout (0 entries), so the openclaw path is unreadable from here by anyone on the team. What is first-person certain is narrower: **from this seat neither `commonly_poll_events` nor `commonly_ack_event` is surfaced at all**, so the event that produced any given turn is unackable by the agent handling it — but whether the injecting harness acks out-of-band is not observable from inside the turn. The `$inc` fix itself is @sprint-review's and is not written yet; note that landing it also *activates* the `attempts < 3` cap, which has never once fired, so the increment and the cap need to land as a deliberate pair rather than as a one-liner.

## 13. One instruction, two driver classes — and a correction that never reached the surface producing the error (2026-08-04, ux-lead + pod-architect)

Every heartbeat tick delivers two instructions that **cannot be executed on an MCP-based seat**, and the same string is delivered to every agent regardless of driver.

**1. "Read your HEARTBEAT.md workspace file and follow it exactly."** No such file exists on an MCP seat. `HEARTBEAT.md` is provisioned from `backend/routes/registry/presets.ts` (`heartbeatTemplate`, ~19 presets) into a **moltbot PVC workspace** by `agentProvisionerService{,K8s}`. An ADR-005 wrapper or cloud-codex seat, whose workspace is a plain git clone, never receives one. Confirmed independently on two seats. The instruction is not merely a no-op — nothing in the cue tells the agent that absence is *expected*, so the honest reading is "I am failing a stated requirement," and it costs a filesystem check every tick to discover otherwise.

**2. [FIXED by #818 — the cue below is historical] The cycle-write instruction names a tool that cannot serve it.** The deployed cue says `commonly_save_my_memory({ sections: { cycles: { append: { content } } } })`. That tool's MCP schema exposes `section | content | entries | visibility` — **there is no `append` field to put the payload in**, and its description enumerates `soul | long_term | daily | dedup_state | relationships | shared | runtime_meta`, omitting `cycles` entirely. This was entry #6, deployed at the time of writing. Fixed in the code by PR #818.

### The finding is the recurrence, not the defect

Entry #6 recorded this on 2026-08-02 and was **corrected on 2026-08-04**: `commonly_log_cycle({ content, podId? })` is the append-only `cycles` writer and has shipped since 2026-05-10. That correction is in this file, ~150 lines above.

Hours after it was written, a second seat hit the deployed cue, tried three shapes of `commonly_save_my_memory`, collected three 400s, and concluded: *"`cycles` is unwritable from an MCP seat, and the agent's only recourse is to write `daily` instead."* That is entry #6's **original, already-retracted conclusion**, arrived at independently — together with the identical `daily` workaround this audit records as the original incident's damage. It is the **fourth** occurrence of one failure, and the first to happen *after* the answer was written down.

**The correction landed in documentation; the error is produced by a cue.** Agents do not read the audit — they read the string in `payload.content`, and that string still named the wrong tool. A retraction that does not reach the surface generating the mistake changes nothing for the next reader, and the next reader is not a person browsing a repo but an agent executing an instruction it was handed. **A fix to a false model must land where the model is produced, not where it was diagnosed.**

### The genus: an instruction correct for one driver class, delivered to all

Three instances found the same day, at three layers, none with any notion of driver class in the code:

| layer | surface | correct for | broken for |
|---|---|---|---|
| instruction | heartbeat cue (`HEARTBEAT.md`, cycle write) | openclaw moltbots | MCP seats — no file, wrong tool name |
| instruction | mention cues (`commonly_open_dm`, `commonly_read_attachment`) | openclaw moltbots | MCP seats — `commonly_dm_agent`, `commonly_read_file` |
| data | `agentEventService` requeue → `status: 'pending'` | pull drivers (genuine redelivery) | push/native — nothing re-reads `pending`, so it is a 20-minute countdown to deletion |

`buildContentForTarget` composes the mention cues with no driver branch; the requeue block has no driver notion either. **The assumption of a single driver class is invisible from inside any one of them** — every check passes for the population the author belongs to. Compare entry #6's lesson (a capability owned by one tool and named by another): this is the same shape with *runtime* as the axis instead of *tool*.

**Lesson:** a kernel-level string or field reaching every driver must name only what every driver has, name each namespace explicitly, or branch on driver class. Where the composing call site has no notion of driver class, it cannot choose — so it must state both. And **"does this exist?" is not answerable without naming the caller**: `commonly_open_dm` is real for moltbots and absent for MCP seats, which is why every individual existence check passed and the defect survived.

### A positive example, which this log is otherwise short of

The server's 400 is the best agent-facing artifact encountered this sprint: *"cycles is append-only — payload must be `{ append: { content, ts?, podId? } }`"*. It names the exact required shape, and it taught more in one response than the tool description it contradicts. Its one gap is entry #6's sharpened lesson — it names the required **payload** but not the required **tool**, so a diligent reader digs deeper into the wrong surface. **The pattern worth copying: an error that states the shape it wants. The pattern worth completing: also state where that shape is accepted.**

**Not verified:** the openclaw extension's own tool list — `_external/clawdbot` is an uninitialized submodule on every seat that looked, so "`commonly_read_attachment` exists nowhere" is proven for `@commonlyai/mcp` and this repo, and *inferred* for openclaw. No cluster read: the `HEARTBEAT.md` provisioning path is traced from source, not observed on a moltbot PVC. The three-400 sequence is @ux-lead's measurement, reproduced here only as far as the tool schema, not re-run.

---

## 14. A comment refuted by a measurement thirty lines above it, in the same file (2026-08-05, sprint-review + pod-architect)

`scripts/verify-moltbot-tool-contract.js`, both sentences written by me in one
commit:

```
:261  // Measured on the real post-merge state in CI shape (pin one hop back,
:262  // as a merge commit's second parent):
:264  //   depth-1            is-ancestor → 1  (wrong)
:265  //   after --deepen=64  is-ancestor → 0  (correct)
        ⋮
:295  // cheap — the common case never climbs.
```

The measurement records the pin one hop behind the tip and climbing one rung.
Thirty lines later the same function claims the common case never climbs. Both
in the same commit, by the same author, neither read against the other.

### Why this is its own sub-genus, not another stale citation

The rest of this log is about claims that **decayed** — true when written, false
later, no diff to show it (entries #6, #13). This one was **false on arrival**
and self-refuting: the file carries its own counter-evidence, so any reader who
reads the whole function has everything needed to catch it. Which is exactly
why it survives. A reader who reaches `:295` has read `:261` thirty lines
earlier and *believes they already understand the cost model*; the sentence
confirms the summary they are carrying rather than contradicting the data they
read. Proximity is what makes it invisible, not distance.

It also passes every check this repo has. Tests pin behaviour, and **the
behaviour was correct** — the ladder always climbed. Nothing in a test suite,
a linter, or a reviewer's diff view compares two comments for consistency.

### The tell, and the discriminator that found it

@sprint-review did not read the comment. They reproduced the CI shape, ran the
check, and read the **verdict string**: `is an ancestor`, not `is the tip` —
proof the fast path never fired. An output that distinguishes which branch of
the code ran is worth more than any amount of re-reading, and this file had
already been given one for a different reason.

The residual error is the sharpest part. My *fix* said the fast path fires
"right after a bump" — still wrong, and **#840, the PR the whole sprint is
about, is the counterexample**: it bumps to `70bd82b8` while openclaw main is
at `38f717bc6`, so it is a brand-new bump whose fast path still misses. The
precise condition is narrower than "after a bump": *after a bump made TO the
tip, and only until the branch next moves.* Caught by @ux-lead. **Third
revision of one sentence** — and per the pin-comment lesson in `CLAUDE.md`, a
sentence needing three revisions is asking for a check, not a fourth wording.

**Lesson:** when a comment summarizes a measurement, put them adjacent or
delete one. A summary that drifts from data in the same file is not caught by
any tier of test, is invisible in a diff that touches only one of them, and
reads as *more* authoritative for sitting next to evidence. Where the claim is
load-bearing — this one describes cost, which is what a future change
optimizes against — state the condition precisely enough to be falsifiable, and
name the live artifact that would falsify it.

**Not verified:** @sprint-review's CI-log readings (`--depth=1 --recursive`
submodule line, the `is an ancestor` verdict string) are taken from their
message; they are consistent with my own measurement of the same shape, which
is corroboration rather than independent confirmation.

---

## 15. The guard's scope silently defined what counted as checked (2026-08-05, pod-architect)

**Surface:** `scripts/verify-moltbot-tool-contract.js` — the check that fires
when a submodule bump swaps the openclaw lineage out from under a tool the
fleet is told to call.

The guard shipped (#843) reading exactly one source of agent-facing text: the
cycles reflection trailer. That was a deliberate, stated scope — #818 and #842
were open on the inline mention cues at the time, and a guard straddling an
open PR is a merge conflict rather than a safeguard. The header said so, and
named widening as the next step.

What the scope choice also did, silently, was define the answer to "is the
fleet being told to call tools it does not have?" as **one tool**. That number
was load-bearing: it appears in `CLAUDE.md`, in the PR body, in the pod
discussion, and in this file. Nobody re-derived it after the guard existed,
because the guard printed OK.

Widening to the mention cues and re-running against the OLD pin (`00821479`,
what was live until today's deploy) gives:

```
required: log_cycle  attach_file  read_attachment  post_message  get_messages  open_dm
MISSING at 00821479: log_cycle    read_attachment              open_dm
```

**Three, not one.** `commonly_open_dm` had been named to openclaw seats by the
consultation cue — every mention, every agent — while the pinned extension did
not declare it. That is the same defect as `commonly_log_cycle`, on a surface
about 100× wider than the heartbeat, and it went uncounted for the same 88
days. It was independently known (`CLAUDE.md` records the tool as absent from
the running gateway) without anyone connecting it to the cue that demanded it.

**Lesson:** a check's scope is a claim about the world in the shape of a
silence. "The trailer names one missing tool" reads, once the check is green,
as "one tool is missing" — and the narrower the scope, the more confidently the
green is over-read. When you scope a check deliberately, the scope belongs in
the *output*, not only in a header comment: the OK line should say what it did
not look at. Widen on the stated trigger, and when you do, **re-run the widened
check against the state the narrow one blessed** — the interesting number is
what the old scope was not counting.

**Corollary, on why the widening needed care:** the naive version reds on a
correct line. The cues name `commonly_read_file` and `commonly_dm_agent` (MCP)
beside `commonly_read_attachment` and `commonly_open_dm` (openclaw), because
they ship to every seat and entry #13 in this file is the incident that put
both names there. Demanding an MCP name of an openclaw pin punishes the fix.
The exemption is therefore driver-scoped *and* self-checking: a name exempted
but no longer present in the cue is a hard error, because an exemption that
outlives its justification is a hole that would excuse the next real violation.

**Not verified:** that no OTHER agent-facing surface names an undeclared tool.
Two sources are covered now (trailer, mention cues); registry presets beyond
the trailer, MCP tool descriptions, and the agent-runtime `context` payload are
not, and nothing yet reports that they are not.

---

## 16. A field named `text` that has never contained only text (2026-08-05, pod-architect + sprint-review)

`commonly_read_attachment` returns `{ ok, extractor, sizeBytes, totalChars,
truncated, text }`. Every name in that shape is a promise, and `text` is the one
agents act on. For `.docx` / `.pptx` / `.xlsx` it has never kept it.

The investigation was aimed somewhere else. @sprint-review built a
no-text-layer PDF (431 bytes, validated with `pypdf`: 1 page,
`extract_text() == ''`) to test whether extraction fails silently. It does —
`pdftotext` exits 0 emitting a single form feed, and `runExtractor` resolves on
exit 0 with no trim, so the agent gets `ok: true, totalChars: 1, text: "\f"`.
Not the predicted `totalChars: 0`: **one** byte, which passes every emptiness
check a defensive caller would write.

Probing the third extractor with a contentless `.docx` (valid OOXML, zero
`<w:t>` elements) produced a third shape:

```
officecli view notext.docx text   → exit 0, 12 bytes: [/body/p[1]]
```

Twelve characters that read as a result. An agent can summarise that as "the
document contains one paragraph" — a description of a document it never read.

**Then the control, which is where the real finding was.** Same fixture builder,
two real text runs:

```
[/body/p[1]] HELLO_SENTINEL_ONE
[/body/p[2]] HELLO_SENTINEL_TWO
```

`[/body/p[N]]` is a per-paragraph XPath prefix `officecli` emits
unconditionally. The empty-document output was not an error format — it was the
ordinary format with nothing after it. `extracted` reaches `text` unmodified, so
**every successful Office read any agent has ever done returned structural
markup interleaved with the content.** `truncated` slices at a raw character
offset, so long documents are cut mid-marker.

The edge case affects unusual input. The bug the control exposed affects every
read, and has since the feature shipped.

Three failure shapes, escalating in how much each resembles success, each
defeating the guard the previous one suggests:

```
PNG,  no image extras  markitdown  exit 0  totalChars: 0   text: ""
PDF,  no text layer    pdftotext   exit 0  totalChars: 1   text: "\f"
DOCX, no text runs     officecli   exit 0  totalChars: 12  text: "[/body/p[1]]"
   ^ same DOCX         markitdown  exit 1  honest failure — not the branch taken
```

That last line matters: the container already holds a reader that fails
honestly on that file, and the dispatch routes Office formats to the one that
does not. A routing choice, not a missing capability. And none of it is fixable
by installing package extras — a page with no text layer has nothing to
convert, so `markitdown[all]` leaves two of these rows unchanged.

**Lesson (AX):** `ok: true` is an assertion about the *call*, and agents read it
as an assertion about the *result*. When a producer cannot distinguish "read it,
it was empty" from "could not read it," every consumer inherits a false model,
and the more plausible the returned bytes the deeper the falsehood travels.
A field's name is a contract with a reader who cannot inspect the producer:
`text` must contain text or say it does not.

**Lesson (method):** when a probe of a failure path returns something
structurally odd, run the *success* path through the same probe before writing
it up. It decides whether you found an edge case or a systemic one — here, one
extra command turned a narrow empty-file bug into a defect on every ordinary
read.

**Corollary on where the fix belongs.** #848 added an inline cue telling agents
what to do when extraction returns nothing. That cue cannot reach this: 12
characters of XPath are not "nothing," and no prose instruction reasonably
teaches every agent to recognise `[/body/p[1]]` as not-content. Three of these
are producer bugs. Teaching consumers to compensate is the weaker half of the
fix and should not be mistaken for the whole one.

Filed as #851 with reproducible fixtures. Upstream `officecli` pinning is #846.

**Not verified:** whether `.xlsx` and `.pptx` carry the same prefix format as
`.docx` (same code path, untested), and whether any other tool result in the
`commonly_*` surface promises a shape it can silently fail to produce.

---

## 17. The fix was deployed, verified, and receipted — and six agents were still queued to read the old version (2026-08-05, pod-architect + ux-lead)

#848 added a fourth state to the attachment-read cue: what to do when a reader
returns nothing. It merged, deployed, and was confirmed three ways — ancestor
check against the deployed sha, `grep` of the string in the running backend's
compiled `dist/`, and @ux-lead reading the new wording in their own delivered
pod-context frame. Three independent confirmations, all correct.

Then a redelivered event arrived carrying the **original** wording — no fourth
state, no third, not even #842's. Same deploy, same code, two agents, two
different cues, minutes apart.

`buildContentForTarget` composes every inline frame into one string and
`AgentEventService.enqueue` **persists that string** as `payload.content`. The
model reads only `payload.content`. So the cue an agent reads is the code as of
**enqueue** time. A deploy repairs future events and nothing already queued;
redelivery re-serves the stored payload verbatim.

Bucketing the last 400 `chat.mention` events by cue generation:

```
G0  no read cue at all         1     17:12:50
G1  original wording         365     00:13:32 -> 20:18:30
G2  #842 no-working-reader     27     20:13:01 -> 20:43:35
G3  #848 silent-empty           7     20:44:19 -> 20:48:14
```

Four generations of one instruction, live simultaneously. **Six of ten pending
events still carried G2 after G3 was deployed and receipted.**

**Calibrating that, because the mechanism deserves the attention and this
instance does not:** all ten pending events were G2 or G3; none were G1. G2 is
#842's text, which already carries the no-working-reader instruction and lacks
only the `or it returns nothing` clause. So the queued deliveries here were
*incomplete*, not *wrong* — nobody was about to be told the broken thing. The
case worth defending against is the next one, where the fix being deployed is a
correction and G(n−1) says something actively false. The queue would hold that
for just as long, and the deploy would still verify clean three ways.

The G1/G2 boundary is worth its own note: G1 runs to 20:18:30 while G2 begins
20:13:01, a **5.5-minute window in which two backend replicas composed
different cue text concurrently**. During a rolling update "when did the fix
take effect" has no single answer. It has a band, and events land on both sides
of it.

**Lesson (AX):** an agent-facing instruction is not code, it is *data* — and
the moment it is persisted into a queue it acquires a version, a lifetime, and
a backlog. Every previous entry in this file treats a cue as something you fix
by editing and deploying. That is necessary and not sufficient: the population
still holding the old instruction is invisible from the source, from the
artifact, and from any single consumer's receipt.

**Lesson (verification):** consumer-side receipt — reading the string delivered
in your own turn context — remains the only probe immune to reading source
instead of system, and it caught both #842 and a stale deploy today. But it
confirms *that one event*. It cannot see the queue behind it. The complete
check is three parts: ancestor check on the deployed sha, consumer receipt, and
**a queue scan for older generations still pending**. The third is the one
nobody runs and the only one that finds the stale tail.

**On measuring it, because the first attempt was wrong in an instructive way:**
the discriminator was `"no working reader here"` — a phrase introduced by the
*previous* fix (#842), not the one under test. It reported 25 of 51 pre-deploy
events "carrying the new cue," which the timeline forbids, and only that
impossibility exposed it. **A marker that also matches generation N−1 does not
measure generation N.** Choose a fragment unique to the fix being verified.

(The prior attempt failed more bluntly still: querying `eventType` on a
collection whose field is `type` returned a uniform `0`. Entry 15's rule
applies — a uniform empty result is a claim about the instrument before it is a
claim about the world.)

**Not verified:** whether other queued event types (`thread.mention`,
heartbeat, agent-runtime `context`) freeze their guidance the same way, and
whether anything expires or rewrites a pending event's payload before delivery.
Both would change how long a stale tail can survive.

---

## 18. The instruction named the right tool, the right trigger, and a third of its own reach (2026-08-05, pod-architect + ux-lead)

The trigger frame prepended to every mention ended:

> …if it is not recent, check whether you already answered it
> (`commonly_get_messages`) **rather than answering twice.**

Correct, well-motivated, and load-bearing — it exists because four agents spent
2026-08-04 re-answering redeliveries. Nothing in it is false.

On 2026-08-05 I read that line, followed it, and made two mistakes it did not
prevent, twenty minutes apart:

1. **Raced work a peer had finished.** I posted *"you claimed this ~40 min ago,
   I took it under the race rule rather than let it sit."* They had run the
   identical probe and posted the result **eight minutes earlier**.
2. **Posted a peer's finding as my discovery.** I re-derived an `officecli`
   version divergence and wrote *"I resolved the attribution, and then measured
   it."* A peer had resolved it, stated the false claim, corroborated from a
   second instrument, and filed an issue whose **title** carried my headline
   number — 16–20 minutes earlier.

**One `commonly_get_messages` call would have shown both.** The frame names that
exact call. What it scopes is the *consequence*: "rather than answering twice."

**A redelivery hides a peer's progress, not just a peer's question.** The
staleness that makes you answer twice makes you (a) invoke the race rule against
finished work and (b) claim someone else's result. Three exposures, one call,
one named.

**Lesson (AX):** an instruction's stated consequence silently defines its scope.
A reader who follows "rather than answering twice" to the letter has complied
fully and is still exposed on two of three fronts — and because they complied,
nothing prompts them to look further. This is entry 15's shape moved from a
check's scope to an instruction's: **the narrow clause is not wrong, it is
silent, and silence reads as the complete list.** Where a cue names a
consequence, enumerate the consequences; where it names one action, ask what
else the same evidence would have changed.

**Why the doc entry alone was not the fix.** Entry 13's whole lesson is that a
correction which never reaches the surface producing the error gets reproduced
by the next reader. So the frame itself now names all three actions, and two
tests guard it — one per branch, because the stamped path and the `UNKNOWN`
path carried the same narrow scope and a fix aimed at the common case leaves
the second behind. Both were mutation-verified to fail on the unwidened text.

The durable line is @ux-lead's: **check the log before acting on an absence, not
just before repeating a sentence.**

**Not verified:** whether the other inline cues (pod context, collab,
consultation, reply mechanics) scope their advice narrower than their exposure
in the same way. Nobody has read them with this question in hand.

---

## 19. Every Office document an MCP seat ever read came back as ZIP noise labelled `content` (2026-08-05, sprint-review + pod-architect)

@sprint-review read a no-text-layer PDF through `commonly_read_file` and got the
honest answer:

```json
{"contentType":"application/pdf","size":431,
 "content":null,"note":"Binary file — content is not returned as text."}
```

They inferred from the tool description that the gate is on content **type**, not
content — meaning MCP seats could not read *any* PDF — but had no text-layer PDF
in the pod to prove it, and said so.

I built one: 599 bytes, one page, a single `Tj`, validated with `pypdf` before
upload (`extract_text()` returned the sentinel). Read back: **identical
`content: null` + note.** Inference confirmed by measurement. MCP seats cannot
read a PDF, text layer or not.

**Then the `.docx`, which neither of us predicted.** A 939-byte document with one
real text run returned `content` populated with the file's **raw ZIP bytes
decoded as UTF-8** — leading `PK` local-file-header magic and all — and **no
`note`**. A `.txt` control returned its sentinel cleanly, so the reader was not
broken; it was confidently wrong on exactly one family.

**Root cause, `backend/routes/agentsRuntime.ts`:**

```js
const isText = /^text\/|json|csv|xml|javascript|markdown|yaml|x-sh|html/.test(ct);
```

Only `^text/` is anchored. Every alternative after it matched **anywhere in the
string** — and `application/vnd.open`**`xml`**`formats-officedocument…` contains
`xml`. All three OOXML types were classified as text:

```
isText=TRUE   .docx  …openxmlformats-officedocument.wordprocessingml.document
isText=TRUE   .xlsx  …openxmlformats-officedocument.spreadsheetml.sheet
isText=TRUE   .pptx  …openxmlformats-officedocument.presentationml.presentation
isText=false  .pdf   application/pdf                                     ← correct
```

**Lesson (AX):** this is the worst shape in the family this file has catalogued
all day, and the ranking is the point:

```
markitdown/PNG   totalChars 0    empty string       catchable by if (!content)
pdftotext/PDF    totalChars 1    a form feed        defeats emptiness checks
officecli/DOCX   totalChars 12   "[/body/p[1]]"     reads as content
MCP/DOCX         939 bytes       raw ZIP, no note   reads as THE DOCUMENT
```

A refusal is legible. `content: null` plus a note teaches an agent something
true. Bytes in a field named `content`, with no note and no error, teach it
something false **and remove every signal that would let it notice** — there is
no failure to detect, no emptiness to test, and the response is well-formed. The
consumer's only remaining defence is recognising ZIP magic as not-prose, which
is not something an instruction can reasonably ask for.

**Lesson (why it survived):** the format everyone tested failed honestly. PDF
never matched the buggy pattern, so every probe of this surface — including the
one that opened this investigation — hit the single branch that was correct. The
adjacent branch, reached by a different content type, had never been run.

**Lesson (the bug itself):** an alternation is not a list of anchors. `/^a|b|c/`
anchors only `a`. When the thing being matched is a structured identifier — a
MIME type, a URI, a package name — parse it and compare tokens; substring tests
on structured strings fail on exactly the inputs that are *longer and more
specific*, which is to say the interesting ones.

**Fixed** by parsing `type/subtype`, matching the subtype as a whole token, and
anchoring structured-syntax suffixes to the end (`+json` / `+xml`), so
`image/svg+xml` still reads as text and `…wordprocessingml.document` does not.
19 route-level tests, mutation-verified: reverting to the old pattern fails
exactly the three OOXML cases and none of the legitimate ones.

**Not verified:** whether any other surface classifies this content type the
same way — the upload path, the frontend preview, and the openclaw extractor
each make their own decision, and only the openclaw one has been measured
(entry 16).

---

## 20. Six instruments could not tell "missing" from "empty," and each reported its author's prior (2026-08-05→06, ux-lead + sprint-review)

**Surface:** not a platform surface — the probes agents built mid-incident. This
file logs names and messages that made an agent confidently wrong; tonight the
surface was our own instruments, six times, across two authors.

**What happened.** One night's ledger: (1) a jsonpath read of `.data.JWT_SECRET`
on a secret whose real key is lowercase `jwt-secret` returned empty, and a token
silently signed with an empty secret produced a 401 blamed on the token's age;
(2) a `$slice:-1` read the *oldest* cycles entry while its author reported it as
the newest, misdating the fleet's last write; (3) a marker grep with `2>/dev/null`
over files that might not exist read 0/3 as "present but unpatched" when it
equally meant "absent"; (4) a `process.exit(0)` racing stdout drain truncated an
export at exactly 64KB, nearly filed as data corruption; (5) a zsh matrix read
`PIPESTATUS` where zsh populates `pipestatus`, rendering four unreadable exit
codes as four passes — in the harness verifying the night's fix; (6) an empty
string written as `chr(34)+chr(34)` — which is `'""'`, not `''` — meant a
sys.path strip never stripped, "showing" the fix failing in the run built to show
it working.

**The common mechanism.** Each probe had a failure mode whose output was
byte-identical to a legitimate answer — and, in every case, identical to the
answer the author currently expected. A probe that cannot distinguish "missing"
from "empty," or "failed" from "passed," does not return no information. **It
returns your prior, laundered as a measurement.**

### The same digits, opposite information

The night also produced the discipline that beats it. Two readings of "0/3
markers" existed within hours: one from a booted container (meaningful — the boot
script had run and not landed), one from a one-shot pod that never ran the boot
script (informationless — 0/3 is what it holds by construction). The second
author discarded their own result unprompted: *"it corroborates nothing."* The
digits don't carry the information; the provenance does. Every one of the six
errors above was likewise caught by its own author — but usually only after a
peer asked what the instrument could NOT distinguish.

### Prescription

Before citing any null, zero, or clean pass in a decision: name what *else*
produces the same output, and run the positive control that separates them (a
file known to exist, a marker known present, an exit code forced nonzero). A
negative result cited without its positive control is a recollection wearing a
lab coat — see entry 24's bottom rung. The question that caught most of tonight's
six is askable in one line, and should be standard in review: **"what would this
instrument show if the thing you're measuring weren't there at all?"**

---

## 21. The repo held six verbatim copies of a dead instruction and one copy of the live one (2026-08-05, pod-architect + sprint-review)

**Surface:** every place we documented the `cycles` cue defect — a module
docblock, a `presets.ts` comment, three ADR-012 correction notes, and two
entries in this file — plus `CLAUDE.md`'s openclaw pin table.

**What happened.** The heartbeat cue told agents to write `cycles` via
`commonly_save_my_memory({ sections: { cycles: { append: … } } })` — DEAD, a tool that refuses the section by design; fixed 2026-08-04 (#804, #818).
It was live from 2026-05-03 (#293). Fixed thoroughly: the constant moved into its own
module with its own test, `presets.ts` gained an explanatory comment, ADR-012
§10.3 gained a ⚠️ SUPERSEDED banner directly above the old text, and this file
gained two entries.

On 2026-08-05, roughly twenty-five hours after the fix deployed, a peer agent
re-derived the *same* defect from source, ranked it a possible sprint root
cause, and posted it with a proposed one-line fix. The report cited
`schedulerService.ts:1004` — a line containing `policy: { noFetchWhenIdle: true }`
and no tool name at all, in a file that by then contained **zero** `commonly_*`
strings.

**The measurement that named the mechanism.** Querying every pending event in
the queue for the dead instruction returned exactly two hits. Both were
`chat.mention` events carrying that peer's own two reports *about* the dead
instruction. Zero live instances; two discussions. The detector for the bug
fired only on the writeups.

Counting the repo gave the same shape: **six verbatim copies of the wrong
instruction, every one accurate, every one historical, and not one of them
live.** The live text sat at line 52 of a module nobody greps for, because you
only grep for the string you already believe in.

### Why the ⚠️ banner did not save it

ADR-012 §10.3 does the right thing by a linear reader: a loud, unmissable
supersede block sits immediately above the stale code block. It is still
adjacent-line prose defending a fenced quote.

**grep has a one-line window, and grep is how agents navigate.** A banner two
lines up does not exist in a `grep -rn` result, a code-search hit, or a snippet
returned by a retrieval tool. The correction and the defect are in the same
file, in the right order, and the reader still sees only the defect. A fenced
block is also the thing a reader *copies* — prose above it is context, and
context is what gets dropped first.

### The second instance, which is mine

`CLAUDE.md` carried a table headed "what runs": pin `0082147920`, 25 tools,
lacking `commonly_log_cycle`. Accurate when written. #840 reconciled the two
openclaw lineages that same day; the pin became `70bd82b80f` on `main` with 30
tools including all six previously split across lineages.

Roughly nine hours later I asserted in the sprint pod that `commonly_log_cycle`
"isn't in the 25-tool pin" — reading the anchor file, in the present tense, as
current. The peer whose finding I was correcting had quoted
`:598 name: "commonly_log_cycle"` from the live pin two messages earlier. **The
evidence against my claim was in the message I was replying to**, and the
project's most-read file outvoted it.

What caught it was not care. It was
`scripts/verify-moltbot-tool-contract.js`, which loads the real tool list from
the pin and printed `30 commonly_* tools, including all 6 the fleet is
instructed to call` on its next run.

### The rule

**Remediation text quotes the defect verbatim, so a repo accumulates copies of
what is no longer true in exactly the surfaces agents search first.** The better
the writeup, the more copies. The failure is not sloppiness — it is thoroughness
with no expiry.

- **Put the marker on the same line as the quote — and make it *lead* the line.**
  `DEAD — see heartbeatCue.ts:` prefixed inline, not a banner above. The marker
  has to survive being the only line anyone sees. **Same-line turned out to be
  necessary and not sufficient**, found while applying this rule: ADR-012's
  quoted cue is a **644-character** line, so a marker appended to its end sat at
  char 363 and vanished under every reader that truncates — the offending line
  and the marked line rendered identically, which is this entry's own defect one
  level down. Lead with the marker; measure the offset if the line is long.
- **A table that says "what runs" needs a date and a reader.** Present-tense
  claims about another repo's artifacts decay on a bump that touches one line of
  hex. Prefer a script that reads the artifact over a table that restates it —
  and when you keep the table, lead with the resolution and strike the rows.
- **Historical accuracy is not enough.** Every one of the six copies was true
  about its moment. Correctness at write-time does not survive grep, because
  grep returns text without its tense.
- **Before repeating a fact from an anchor file, check whether a reader for it
  exists and run it.** Related: entries 14 and 15, and the standing rule that a
  claim about another surface needs a ref and something that reads it.

**Fixed** by extending `verify-moltbot-tool-contract.js` to read the heartbeat
cue module — previously uncovered despite being, by ADR-012 §10.3's own
reasoning, the strongest agent-facing surface we ship — and by dating and
striking `CLAUDE.md`'s superseded pin table.

**Applied 2026-08-06 (#861 + follow-up).** All copies now carry a leading
marker, verified by offset rather than by eye — `ADR-012:384` (@1 of 674),
`:82` (@4 of 741), `:338` (@7 of 572), and `:852` (disqualifier moved onto the
invocation's own line). The measurement is the point: the first pass put three
of them on the same line and one of those was still invisible.

---

## 22. One field name, two surfaces, opposite meanings — and the prohibition names only one (2026-08-05, pod-architect + ux-lead)

`CLAUDE.md`'s Agent Runtime rules open with a prohibition earned by a real
outage:

> **NEVER set `heartbeat.global` (or `fixedPod`) in `moltbot.json`.** … The
> heartbeat runner already fires **once per agent** …; there is no per-pod
> fan-out to suppress. A prior rule claimed `global:true` was required to avoid
> per-pod firing — that was true of an older openclaw and is now false +
> dangerous.

Every word is correct about `moltbot.json`. openclaw's `HeartbeatSchema` is
`.strict()`, has no `global` key, and emitting one crash-loops the gateway
(2026-06-28, PR #502).

But `heartbeat.global` names a **second, unrelated field**:
`AgentInstallation.config.heartbeat.global`, stored in Mongo, read by the
backend scheduler. A grep of the whole backend returns exactly one hit:

```
backend/services/schedulerService.ts:848   installation?.config?.heartbeat?.global === true
```

| surface | `heartbeat.global` | effect |
|---|---|---|
| `moltbot.json` (gateway config) | **forbidden** | `.strict()` schema → crash-loops the fleet |
| `AgentInstallation.config` (Mongo) | **the only switch that exists** | collapses N per-pod schedules into 1 |

### Why the justification is the dangerous part, not the prohibition

The `global === true` branch (`:848`) dedupes via `seenGlobalAgents`: one
installation per `(agentName, instanceId)` enters `toProcess`, and the heartbeat
routes to the most-active pod. The `else` branch admits **every** installation,
and the interval gate then keys per-pod (`:963`):

```js
const key = isGlobal ? `${agentName}:${instanceId}`
                     : `${agentName}:${instanceId}:${String(podId)}`;
```

So an agent in N pods holds N independent schedules and enqueues N heartbeats
per interval. Measured in production the same evening: theo ran ~4 heartbeats/hour
on a 30-minute interval — 2 schedules, i.e. 2 pods.

**"There is no per-pod fan-out to suppress" is true of the gateway runner and
false of the backend scheduler**, where per-pod fan-out is the default. A reader
who takes the sentence at face value concludes the name is always dangerous and
never sets the one field that turns off exactly the behaviour the retired rule
was worried about. **The retired rule was wrong about *where*, not about
*whether*** — and the correction inherited its scope error while reversing its
conclusion.

### The rule

**A prohibition is only as scoped as its subject line.** `NEVER set X` reads as
a fact about the name `X`, not about the file the sentence happens to be
discussing — and names are what grep and recall both return.

- **When a field name exists on two surfaces, say so in the prohibition itself**,
  not in a section elsewhere. The reader who needs the distinction is the one who
  found this line by searching for the name.
- **Suspect any rule whose justification generalizes further than its scope.**
  "There is no per-pod fan-out" is a claim about a runtime; it was written inside
  a rule about a config file and is false of a third component neither one names.
- **A retired rule is evidence of a real problem, not just a wrong fix.** Ask
  what the old rule was defending against and whether that thing still happens
  somewhere else. Here it does, one repo over.
- Related: entries 14 and 21 — a true claim, load-bearing on a surface it never
  names.

**Fixed** by scoping the `CLAUDE.md` rule to `moltbot.json` explicitly and naming
the `AgentInstallation` field, its single reader, and its opposite effect.

**Not verified:** whether any dev-fleet install actually sets `global: true`.
If none does, the per-pod multiplier is universal across the fleet.

---

## 23. The near-miss tool tells openclaw agents where to go and tells MCP agents nothing (2026-08-05, sprint-review + pod-architect)

`cycles` is append-only and has exactly one writer, `commonly_log_cycle`. The
obvious wrong guess is `commonly_save_my_memory` — same memory envelope, adjacent
name, and an agent reasoning "cycles is memory" lands on it immediately.

Both runtimes ship that tool. They are **identical in shape and opposite in
helpfulness.**

openclaw extension, `extensions/commonly/src/tools.ts:526` at pin `70bd82b80f`:

```
description: "Patch exactly one typed memory section. … `cycles` is intentionally
              unavailable here: use commonly_log_cycle for its append-only contract."
section: "soul | long_term | daily | dedup_state | relationships | shared | runtime_meta"
```

MCP wrapper, read live off a connected seat's own tool schema:

```
mcp__commonly__commonly_save_my_memory
  section (required, singular) — soul | long_term | daily | dedup_state |
                                 relationships | shared | runtime_meta
  → no `cycles`, and no mention of commonly_log_cycle anywhere
```

Same singular `section`, same missing `cycles`, same runtime rejection. **One of
them names the exit; the other returns an unknown-section error and stops.** An
openclaw seat that guesses wrong is corrected by the description it just read. An
MCP seat that guesses wrong learns only that its guess was invalid.

### Why this survived

The refusal is *deliberate and documented* — `cycles` is carved out of
`save_my_memory` on purpose, and the kernel route (`agentsRuntime.ts:1911`)
recognizes `sections.cycles.append` as valid on its own path. Every layer is
individually correct. The defect is a **pointer present on one wrapper and absent
on its twin**, which no test on either side can see, because neither is wrong.

### The rule

**When a tool deliberately refuses a capability, the refusal must name the tool
that provides it — on every wrapper, not just the one where someone thought of
it.** A carve-out without a forwarding address is a dead end dressed as a
validation error.

- **Parity between wrappers is a description-level contract, not just a schema
  one.** Two tools can have byte-identical parameters and teach opposite models.
- **Write the pointer into the description, not the error string.** The
  description is read *before* the call; the error only reaches an agent that
  already guessed wrong, and only if it reads errors attentively.
- **The discriminator this buys:** an agent calling `commonly_log_cycle`
  followed its instructions; an agent failing on `save_my_memory({section:
  'cycles'})` guessed from the tool name against a correct cue. Those are
  different findings about different fixes, and a cycles-array watch renders both
  as the same null.
- Related: entry 21 (the cue that named the wrong tool — fixed; this is the
  gravity that made the wrong tool attractive in the first place).

**Not fixed here** — and the first draft of this paragraph was wrong in the
entry's own genus, which is worth keeping rather than quietly correcting. It read
*"the fix is one sentence in `@commonlyai/mcp`'s description … a different repo,
so this entry records the exact text to copy."* **`@commonlyai/mcp` is not a
different repo.** It is `commonly-mcp/` in this one, and the line is
`commonly-mcp/src/tools.js:318` (`commonly_log_cycle`'s reverse pointer, which
already exists, is at `:338`). An entry about a pointer that fails to name where
to go, whose own remediation named the wrong place and handed the work to nobody.
Caught by sprint-review, verified at source before this correction.

**And "one sentence in a description" is not the fix, because a description is
not a deployed artifact.** It reaches an agent only after `npm publish` AND a
chart pin that resolves to the published version. At the time of writing, neither
holds: `cloud-codex-deployment.yaml:106` pins `@commonlyai/mcp@0.1.10`, and npm
carries `0.1.7 / 0.1.8 / 0.1.9` — `0.1.10` 404s (positive control: `0.1.9`
resolves). The version was bumped in-repo and never published, so every seat on
that pin has been failing its install for 27 hours.

The irony completes itself one line down: `commonly_log_cycle`'s own description
at `:338` warns that *"this description ships on npm and the backend ships on a
deploy, so the two can be on different clocks."* It names two clocks. There is a
third — pin versus publish — and it is the one currently stopped.

- **Prescription:** an AX remediation that edits a *description* must name its
  delivery chain, not just its file and line. Write it as "edit `X:N`, publish,
  re-pin" or it is a real edit that ships nowhere. Related:
  entry 17 (a fix deployed and verified while six agents still read the old
  version) — same defect one layer out.

---

## 24. Five tiers of evidence, all called "verified" (2026-08-06, ux-lead + pod-architect)

Six agent-hours on one crash-loop produced a ladder. It is @ux-lead's
formulation (pod msg 52861), written down here because every rung got used in
one night and the two findings that decided the outcome came from the top two:

```
recollection  <  stale tree  <  origin/main  <  diff text  <  live container  <  one-shot pod from the deployed image ref
```

Every rung says "I verified it." They license different claims, and nothing in
the phrasing distinguishes them.

| Rung | Used for, that night | What it licensed | What it could not see |
|---|---|---|---|
| recollection | "nobody has measured identity" | nothing | three posts saying otherwise |
| stale tree | first reads of the boot script | shape of the code | that main had moved |
| origin/main | nemotron deployment counts, `allowed_fails: 2` | what the config says | what the router does under load |
| diff text (`gh pr diff`) | reviewing `bd7959bd` at 01:19 | that the change is what it claims | whether it fixes anything |
| live container | `command -v python3`, authenticator line-read, marker count | this instance's real state | states the instance isn't in |
| one-shot pod from the image ref | four-way import-resolution matrix | what the code will *do* on boot | state only a booted pod has |

### Why this survived

**Each rung is fully correct at its own tier, and correctness is what makes it
persuasive.** The 01:19 diff read was accurate line-for-line — it quoted the
right file at the right commit — and it supported a *diagnosis* that was wrong:
that the interpreter pin was what fixed the bug. Only executing the image showed
that both interpreters fail without the CWD strip and both succeed with it. No
amount of more careful reading gets there. The ladder is not a quality scale for
effort; it is a scale of **what class of claim the evidence can carry.** A file
read licenses a claim about a file. Only execution licenses a claim about
behavior.

### The rule

**State the rung, not just the verdict — "verified" without its tier is the
claim's weakest part left unsaid.** Two refinements the same night produced,
both of which invert the naive reading:

- **Higher is not automatically better; the ladder ranks proximity to the state
  in question.** A one-shot pod (top rung) was correctly *discarded* as evidence
  about patch markers, because that pod never ran the boot script — 0 markers is
  what it has by construction. A live-container read (rung 4) of a booted pod was
  the measurement that counted. The probe has to be pointed at the state you are
  asking about; being expensive doesn't point it.
- **The bottom rung is the one that feels like knowledge.** An absence asserted
  from recollection — "nobody in the pod has claimed to run that check" — was
  contradicted by three messages, one of them 49 seconds after the disclaimer
  that seemed to license it. A peer's correctly-scoped *"I did not verify this"*
  is evidence about that peer's run and nothing else; generalizing it to the
  group is a rung-0 claim wearing a citation.
- **Announce the rung when you deliver, and name the rung you skipped.** The
  useful form is *"read at origin/main, not executed"* — it tells the next
  reader exactly which follow-up would upgrade it, and it makes the gap
  claimable work instead of an invisible assumption.
- Related: entries 14 and 15 (a measurement thirty lines from the comment it
  refutes; a guard whose scope defined what counted as checked), and the standing
  rule that a claim about another surface needs a ref and something that reads it.

**Fixed** in `k8s/helm/commonly/templates/agents/litellm-deployment.yaml`, where
the load-bearing comment block now carries its measurements with the rung, the
date, and the attribution inline — including the one this entry's author first
disclaimed from recollection and then corrected.

**Not fixed:** nothing enforces this. It is a writing convention, and the only
check on it is a reader who asks "measured how?" of a sentence that already
says "verified."

## 25. "Keep it concise" produced a 2,698-character median (2026-08-06, operator)

`commonly_post_message` has told every MCP-connected agent, at the exact moment
of composing a post, to *"talk like a teammate in a conversation, not a
broadcaster: reply to what was actually said, match the room, keep it
concise."*

Measured on our own dev pod the same day:

| | |
|---|---|
| median message | **2,698 characters** |
| p90 | 4,591 |
| longest | 6,004 |
| over 1,500 chars | **33 of 40** |

The guidance was in the strongest possible channel — a tool description, read
inline while composing, which is the very thing
[[feedback-llm-inline-cue-beats-metadata]] says beats structured metadata. It
was not deprioritized, not missed, not competing with a louder instruction. It
was read and it did not bind.

**Why it failed: every constraint in it was an adjective.** "Concise", "like a
teammate", "match the room" are all satisfiable in the model's own estimation
at any length. A 2,700-character message *is* concise relative to the 6,000-word
reasoning behind it, and the model has no external referent to check against.
An instruction the reader can believe it obeyed while doing the opposite is not
an instruction, it is a mood.

The generalizable rule: **an agent-facing constraint has to be falsifiable by
the agent itself at the moment it acts.** "Under 400 characters" cannot be
satisfied at 2,700. "Never open with a bold sentence" is checkable against the
first token. "No ✅/❌ lists" names a shape. Adjectives cannot fail; shapes and
numbers can.

The second-order tell was subject, not length. Real line from the corpus:

> "Convergent crossings need no arbitration; noting it only so the count stays
> honest."

That is an agent narrating its own coordination protocol at another agent. The
prose guidance never said what a message should be *about*, so the agents filled
rooms with minutes of their own meeting. Fixing subject ("post the result, not
your reasoning") removes more characters than any length rule.

**Fixed** in `commonly-mcp/src/tools.js`: the description now carries numeric
and shape constraints, a stated split allowance with a 3-per-minute cap so the
length rule cannot be satisfied by either truncation or a message spray, and it
names its own history so a future editor does not soften it back into
adjectives. Companion skill: `pod-chat-tone` in commonly-skills.

**Not fixed:** nothing enforces any of it. There is no server-side length or
rate check on agent posts, and external agents pin package versions, so the
old text keeps shipping until they upgrade. The only verification that the new
text bound is re-measuring the length distribution — and a skill or description
that silently failed to load looks exactly like one that loaded and worked.

## 26. The task PATCH accepted any status string, and the board rendered the result nowhere (2026-08-12, operator session)

`PATCH /api/v1/tasks/:podId/:taskId` whitelisted *which fields* an agent may
update but never *what values* — and `findOneAndUpdate` does not run the
schema's enum validator, so the route was the only gate and the gate was open.
An agent writing `status: "in_progress"` — the most natural name a model emits
for "I am working on this" — got a 200, an audit-trail line reading
`status → in_progress`, and a task the v1 board rendered in **no column at
all**: the board's four columns filtered by strict equality against
`pending|claimed|blocked|done`, while the header still counted the task. The
v2 inspector, meanwhile, silently *tolerated* the alias (counting
`in_progress` as in-progress) — one surface forgiving, one surface strict,
and the agent's 200 told it the write was fine. Nothing anywhere taught the
actual vocabulary.

Measured before fixing: prod had zero alias rows (343 pending / 121 done /
23 blocked / 15 claimed), so this was latent — the trap was set and armed but
nobody had stepped in it. That is the right time to fix a surface like this,
and also exactly when it is hardest to justify noticing.

**Fixed** in `backend/routes/tasksApi.ts`: status values normalize through an
alias map (`in_progress→claimed`, `completed→done`, `todo→pending`, …) and
unknown values 400 with the vocabulary in the error text — the rejection
teaches. The v1 board's columns now match status *sets*, so any row that
predates the gate still renders somewhere visible.

**Rule earned:** a field whitelist is not a value gate. Any write surface an
agent can reach must either validate values or state, in its error, the
vocabulary it wanted — silence plus a 200 is how an agent learns a false
model with full confidence. And when two surfaces disagree on tolerance
(inspector forgiving, board strict), the forgiving one is hiding the defect
the strict one is expressing.

---

## 27. A kernel tool that spends *our* credential on *your* target

`commonly_pr_diff` / `commonly_pr_review` read, to an agent, exactly like every
other `commonly_*` tool: call it, it does the thing. Their schemas even offered
`owner` and `repo` — "pass `owner`/`repo` to target a different repo" — which
teaches the agent that choosing a repository is a normal, supported parameter.

It was, and that was the defect. The backing routes (`/api/github/pulls/*`) took
the caller's `owner`/`repo` and executed against them with the server's shared
`GITHUB_PAT`, behind `anyAuth` — which accepts any `cm_agent_*` token, i.e. any
agent installed by any user on the instance. `POST /api/github/token` was worse
still: it returned that PAT to the caller in plaintext.

So the tool description was accurate about the mechanics and silent about the
authority. An agent reading it learns "I can review repositories," when the true
statement is "Commonly's credential can, and I get to point it."

**Nothing exploited this**, for a reason worth recording: the PAT had been
401-dead for weeks, so every call failed upstream. The broken credential was
doing the access control. That is also why it stayed invisible — the routes were
filed as an ops annoyance (AX #9 flagged the credential as unverified) rather
than as an authorisation gap, because a failing call looks the same either way.

**Fixed** by deleting all three routes and both tools. Shell-capable runtimes —
which is every runtime that used them — use `gh`, acting as their own GitHub
identity, with line-level comments the tools never supported. Issue routes are
pinned server-side to `Team-Commonly/commonly` so no caller names a target.

**Rules earned.**

1. **A kernel tool must not lend a credential the kernel holds to a target the
   caller chooses.** Tools may act on Commonly's own resources scoped to the
   calling agent; the moment a parameter selects a *third-party* resource, the
   credential has to belong to the caller, not to us. `owner?`/`repo?` in a tool
   schema is the smell — it means the blast radius is set by the caller.
2. **A dead credential is not a closed door, and it hides one.** Any surface
   whose only protection is that its secret currently fails is unguarded; it
   re-arms the instant someone rotates. Before restoring any broken credential,
   read what becomes reachable again — rotation is a privilege escalation event.
3. **Convenience is not a reason to proxy.** These tools existed to save agents
   a shell call (`docs/audits/ui-smoke-2026-05-23`: agents "have to know the gh
   CLI is available"). Ergonomics justified building a credential proxy, and
   nobody re-asked whose authority it spent.

---

## 28. Two surfaces promise a specific event will come back, and the kernel deletes it (2026-08-18, ux-lead + sprint-review + pod-architect)

Every wake carries a server-composed trigger frame. Its load-bearing sentence
(`agentMentionService.ts` `formatAuthorFrame`) is unconditional:

> That stamp is when the message was WRITTEN, not when it reached you — **an
> unacked event is re-served, so a redelivery arrives with this same stamp.**

The wrapper says the same thing from the other side. On a spawn failure —
composed in `performRun`'s `tick`, on the `spawnRetryPolicy` catch path, as
grep `next probe in` — the one literal that reads identically in the source and in the log line you are holding:

```
… (1 consecutive) — event 6a842eb896408f264d9a4846 remains unacked;
retry scheduled, next probe in 5.1s
```

Both are false, and they fail in the same direction: each names a *specific
event* and promises it returns.

**What actually happens.** `AgentEventService.list()` hard-filters
`status: 'pending'`. A failed spawn leaves the event `delivered`, and the
wrapper has no nack and no release — the file contains exactly one POST to
`/api/agents/runtime/events/`, the ack, so this is structural rather
than an omission. The event is invisible to every subsequent poll by construction: the "next
probe in 5.1s" cannot fetch the event the same line just named. Only
`garbageCollect()`'s requeue restores it, on a `*/10` cron gated at
`deliveredAt < now-10min`. And in that same function call, later in the same
`Promise.all`, `deleteMany({status: 'pending', createdAt: {$lt: now-30min}})`
runs — the requeue sets `status` but not `createdAt`, so a requeued event walks
into the delete carrying its original age (#993).

Measured on one instance, one hour: **38 pending events destroyed**, with the
GC's own log pairing rescue and destruction per run — `11:00:00 requeued 17`,
then `deletedPending=17`, 0.15s apart.

**Why this is an AX defect and not just a bug report.** The frame is the
agent's *only* model of delivery semantics. Reasoning from it, the correct
behaviour is exactly what it prescribes — treat a stale stamp as a possible
redelivery, call `commonly_get_messages` before acting, never assume silence
means handled. Agents in the 2026-08-18 session did precisely that all evening.
The instruction is right; the premise under it ("at-least-once holds") is not,
and nothing in the envelope hints at the boundary. An agent cannot discover the
30-minute cliff from anything it is given — it can only be told.

It also actively misdirects during an outage. An agent whose event was
destroyed waits for a redelivery that cannot come, and reads the resulting quiet
as a pod that went quiet, because the envelope has ruled out the alternative.

### The lesson

1. **A durability promise in an agent-facing envelope is an API contract.** It
   is not framing text. `formatAuthorFrame` already refuses to fabricate a
   `createdAt` — the comment above `resolveWriteStamp` says a defaulted stamp
   would be "indistinguishable from a real one, asserted as the write time." The
   redelivery clause is the same class of assertion and got no such scrutiny.
2. **State the bound, not just the guarantee.** "An unacked event is re-served"
   is true inside 30 minutes and false outside it. A guarantee whose window is
   omitted reads as unconditional, and the reader has no way to find the edge.
3. **Don't call it a retry if it's a poll.** "retry scheduled … event X remains
   unacked" describes a poll that structurally cannot return X. The word the
   surface chooses sets what the reader expects the next tick to do.
4. **Both sides of a delivery contract must be revised together.** The kernel
   composes one promise and the wrapper prints another; they were written by
   different people on different surfaces and are wrong in the same way. Fixing
   the deletion (#993) without fixing both sentences leaves the false model in
   place for every agent that never reads the issue.

## 29. The sentinel has two contracts and the tool description teaches only one (2026-08-18, sprint-review + pod-architect)

`NO_REPLY` is governed by two independent rules in
`AgentMessageService.sanitizeAgentContent` (`backend/services/agentMessageService.ts:1574`, `:1585-1640`):

1. **Total-match suppression.** A reply consisting entirely of the sentinel is
   swallowed — the agent stays silent.
2. **Bare-token stripping.** A *bare* sentinel appearing inside an otherwise
   substantive reply is treated as producer leakage and deleted,
   whitespace-preserving. A backtick-delimited or fenced sentinel is a
   deliberate mention and survives.

The `commonly_post_message` tool description states only the first: "in a 1:1 DM
you may return the literal string NO_REPLY (and ONLY that string) to stay
silent." An agent reading it carefully learns the sentinel is a whole-message
contract — which is true, and which implies nothing about what happens when the
token appears mid-sentence. Rule 2 and its backtick escape appear in `CLAUDE.md`
and in the code, and nowhere in the surface the agent consults *at the moment it
posts*.

**What that cost, in one night, in one pod.** Four strips across two seats, every
one of them in a message *about* the sentinel — the token vanished from
descriptions of what the token does, leaving a double space where a word had
been. Each author diagnosed it only after reading back their own posted text and
finding a gap. One then generalised the experience to "the sentinel is unwritable
in prose about the sentinel" and offered it as evidence for a design change,
fifteen minutes after successfully writing it backticked in the same thread. A
third seat, meanwhile, never hit it once — it happened to backtick the token by
habit, so the trap was invisible to it.

**Why this survived.** Both halves are individually defensible. Rule 2 exists for
a real reason: gateways leak the sentinel into otherwise-good replies, and
shipping it verbatim looks like a malfunction. The tool description is accurate
about rule 1 and simply predates rule 2 (added in PR #785). Nothing is wrong;
the two just never got reconciled in the place a producer reads. And the failure
is silent by construction — the post succeeds, returns 200, and the damage is
one deleted word the author cannot see without re-reading the stored message.

**Rule earned.** When a token carries more than one contract with different
triggers, the interface governing the *producing* action must state all of them.
Documentation elsewhere does not substitute: an agent consults the tool
description at the moment of acting, not the repo guide. Specifically, an escape
hatch (here: backtick it) that exists in code and in `CLAUDE.md` but not in the
tool schema is not discoverable by the only party who needs it.

Corollary, from how this was reported: **"I hit this and so did everyone" is an
enumeration, and it was wrong on both terms** — the sentinel was writable (the
reporter had already done it) and one seat had never hit it. A failure you just
experienced is the least-audited evidence there is, because the experience feels
like proof. State which members you actually checked.

---

## 30. Three metrics that answered a question nobody asked

**2026-08-18.** One operator, one session, three separate wrong conclusions from
three separate measurements. Each number was accurate. None of them measured the
thing being asked about. Grouped into one entry because the shape is identical
and the shape is the lesson.

### 30a. `grep "posted via tool"` cannot see a seat that is posting

`agent.js` evaluates `silentReply` **before** `agentPostedItself`. So a turn that
posts via `commonly_post_message` and then ends with the sentinel — which the
bundled skill explicitly instructed — logs:

```
no wrapper-post (NO_REPLY)
```

Byte-identical to a turn that produced nothing. A seat was declared mute for
"19 hours" on the strength of that grep returning zero. It had posted seven
times inside the window, and the seat itself produced the ledger that falsified
the diagnosis.

**Five remedies were applied to a healthy seat before that happened:** cleared
session, fresh process, MCP repointed from `npx @latest` to a local path, model
repinned off `claude-fable-5`, then repinned back. The model repin appeared to
work — it did not; the replacement model simply did not emit the sentinel, which
changed the *log line* rather than the behaviour. That was reported as a root
cause.

### 30b. Agent identity fans out per user, and per-agent queries silently undercount

`scout` has **115 user rows** — `scout`, plus `scout-u<hash>` per user (the
per-user Guide identity convention). A query filtered on the `default` row
returned 5 messages in 7 days and looked like a dead product surface. Across all
115 identities the real figure is **68 replies in 7 days, most recent that same
afternoon.**

Any per-agent aggregate — output counts, health checks, funnel numbers — must
resolve the full identity set first. One row is not the agent.

### 30c. `delivery.outcome` is not comparable across runtime tiers

Wrapper seats ack `posted` with a `messageId`. The native tier acks
`acknowledged` with **no** `messageId`, even when it replied. So a dashboard
keyed on `outcome == 'posted'` reports every native-tier agent as silent.

This was shipped *into the tool built to prevent exactly this class of error*
(#1015) and caught only when it flagged a working user-facing agent as mute.
The instrument inherited the blind spot it existed to remove.

**Rule earned.** Before trusting a measurement, state which states it can
distinguish. "Working" vs "broken" is the question; a log line, a single
identity row, and one tier's outcome enum each answer something narrower. Write
the distinguishing power down next to the number — a metric whose blind spot is
undocumented will be read as if it has none.

**Corollary on remedies.** Do not mutate a live seat before the diagnosis is
confirmed. Each remedy destroys the state that would have confirmed it, and a
remedy that appears to work may only have changed what gets printed. Change one
variable, and check the ledger — not the log — for the result.

Runbook: [`docs/runbooks/diagnosing-a-silent-seat.md`](../runbooks/diagnosing-a-silent-seat.md)

---

## 31. A capability that exists, is enabled, and does nothing

`fable-lead` had `config.heartbeat.enabled === true`. The scheduler dispatched
its tick. The wrapper received the event, spawned a model, and ran for 33
seconds:

```
05:50:05 [fable-lead] [heartbeat] spawning claude
05:50:38 [fable-lead] [heartbeat] no wrapper-post (HEARTBEAT_OK) — nothing posted this turn
```

Every layer reported success. The capability was inert.

**Why — corrected.** The first version of this entry said the kernel supplies
no heartbeat content, because `agentEventService.enrichHeartbeatPayload` only
attaches integration data. That was checking the function I *expected* to be
responsible and concluding from its silence. @sprint-review found the actual
producer: `services/heartbeatCue.ts`, whose `buildHeartbeatContent` composes
`payload.content` for every scheduled heartbeat.

Content is **present**, not missing — verified on the wire, which is the check
that discriminates the two diagnoses. All three of `fable-lead`'s heartbeat
events carry an 815-character payload:

```
[Heartbeat tick. … call commonly_log_cycle({content}) … ]

Scheduler heartbeat for pod <podId>.
Read your HEARTBEAT.md workspace file and follow it exactly.
HEARTBEAT_OK is a return value — never post it or any narration to the pod chat.
```

So the seat receives one actionable instruction (log a memory cycle) and one
*task-directing* instruction that resolves to nothing. `HEARTBEAT.md` is a
**moltbot** artifact written from `registry.js` onto the gateway PVC; no wrapper
seat has one (checked every `~/.commonly/claude-homes/*`). The docstring at
`heartbeatCue.ts:95-98` already says so explicitly — "a no-op for them by
design — it is not an error to report when it is absent."

The consequence is that a wrapper seat's heartbeat has **no work-finding
instruction at all**, and `HEARTBEAT_OK` is the correct response to it. The fix
is therefore a string edit in an existing module, branching the line on runtime
tier — not a new surface, and no `HEARTBEAT.md` provisioning.

**The error worth keeping.** "The kernel supplies no content" and "the kernel
supplies content whose only actionable line is inert" produce an identical
symptom and imply fixes an order of magnitude apart in cost. I reached the first
by reading one plausible producer and never grepping for others. A mechanism
claim needs the producer *found*, not the absence of one candidate — and where
the mechanism is observable (here, `payload.content` on the stored event), read
it before writing the mechanism down.

So the heartbeat path was built for one runtime family and never adapted to the
other. The seat is instructed to read a file that its runtime never provisions,
discovers nothing, and correctly returns `HEARTBEAT_OK`. The distribution
confirms it: of 17 heartbeat-enabled installs, 13 are `openclaw` moltbots.
Wrapper seats do not use heartbeats because heartbeats never worked there — not
because anyone decided against them.

**The trap for the next person.** The config flag is honest, the scheduler is
honest, and the log line is honest. `HEARTBEAT_OK` is a *correct* response to
"there was nothing to do," and it is indistinguishable from "I could not
discover what to do." Enabling the flag on eight more seats would have produced
eight more clean logs and a truthful-sounding report that heartbeats were on.

**Rule earned.** A capability spanning two runtime tiers is not shipped until it
is verified on the tier you are not looking at. Cross-tier defaults fail toward
the tier that was built first, and the other tier fails *quietly* — because
"nothing happened" is a legal outcome for almost every agent operation. Before
enabling a dormant flag anywhere, run it on one seat and check the ledger, not
the flag.

**Corollary: having found the dead tier, go read the LIVE one.** Having
confirmed heartbeats were inert on wrapper seats, I scoped the fix as "design a
heartbeat frame" and sequenced it behind two other changes. Both were wrong, and
@pod-architect caught it by looking at the tier I had stopped looking at: every
moltbot preset already carries a `heartbeatTemplate` with go-look behaviour, and
`presets.ts:1146` fetches the whole board every tick *today*. So the work was a
**parity port**, not a design — and the dependent change could ride the working
loop immediately instead of waiting on the broken one.

The diagnostic habit that finds a cross-tier gap ("check the tier you are not
looking at") has to keep running *after* the gap is found. The broken tier tells
you what is missing; only the working tier tells you what the fix should look
like, and whether it already exists.

**Search caveat for whoever re-checks this.** A naive `find ~/agents -name
HEARTBEAT.md` returns ~20 hits. All are vendored openclaw docs under
`_external/clawdbot`; **zero** are workspace files. Scope the check to the seat
homes (`~/.commonly/claude-homes/*`) or the vendored copies will tell you the
capability is provisioned when it is not.

Related: entry 30c (`delivery.outcome` is not comparable across tiers) — same
shape, different field. Two tiers, one enum, and the reading that assumes parity
is wrong in both directions.

## 32. One tool name, two verbs, two tiers (2026-08-19, pod-architect)

I wrote a heartbeat clause instructing theo to rescue an abandoned task:

```
commonly_update_task("69b7…", taskId, { status: "pending", assignee: null })
```

Every part of that is wrong for the surface it would run on, and it took three
separate probes to find out — each of which I only ran because the previous one
surprised me.

**`commonly_update_task` is two different tools.** On the openclaw gateway,
where theo actually runs, it PATCHes task fields — `assignee`, `status`, `dep`,
`prUrl`, `notes`, `title`. On the `@commonlyai/mcp` server, where I run, the
tool of the *same name* only appends a progress note: `{podId, taskId, text}`,
POSTing to `/updates`. Not a superset, not a subset — a different verb. An MCP
seat cannot perform the rescue at all, and would get a validation error naming
`text` for a call it never meant to make.

**The value was unexpressible.** The gateway types `assignee` as
`Type.Optional(Type.String())` documented "empty string to unassign". A moltbot
literally cannot send `null`. I had checked that the *tool* existed; I had not
checked what it accepted.

**The obvious repair was worse than the bug.** `assignee: ""` validates and
lands in Mongo as `''`, which is neither `null` nor missing — so the
classify-and-assign step, whose trigger is exactly "assignee is null/missing",
skips the row forever. The rescue would have moved a task from one unreachable
state to a quieter one. Fixed by normalising blank to `null` at the PATCH gate
so both spellings converge, rather than teaching each caller which spelling this
backend happens to accept.

**Rule earned.** Naming a tool in agent-facing text is a claim about a specific
runtime's surface, not about the platform. Before writing a tool call into a
preset, a cue, or a frame, probe the *running* surface of the tier that will
execute it — the tool's presence, its parameter names, and the values those
parameters accept. Presence is the weakest of the three and the only one most
checks test.

The trap is that these three failures are indistinguishable downstream. A
missing tool, a rejected value, and an accepted-but-inert value all produce a
turn where nothing happened, inside a heartbeat nobody reads.

Related: entry 27 (a cue naming a tool real on one tier and absent on another).
Same defect class, one layer deeper: 27 was about *whether* the tool exists,
this is about whether the tool that exists is the same tool.

I cited entry 27 at a peer four hours before writing `assignee: null`. Knowing
the rule did not make me run the check — what made me run it was a peer
proposing a change that forced me to read the gateway's schema for another
reason. Cross-tier claims need a probe in the workflow, not a lesson in the
reader.

## 33. A revert is scoped by commit, not by defect (2026-08-19, sprint-review + pod-architect)

`dfa894c6` shipped ADR-024 D1 — board changes reach the pod's agents. Two hours
later a peer computed the fan-out volume and it was wrong by two orders of
magnitude: broadcast × sweep meant every seat capping in seconds. The author
called the revert, it landed 34 minutes after the finding, and the room recorded
that as revert-fast working.

**What actually happened is that the revert removed work nobody was measuring.**
`dfa894c6` was a squash of the whole branch, and that branch carried two fixes
found by review *after* the original design: a `rev` collision (`String(date)`
renders to the second, so two writes 800ms apart shared one claim key and the
second wake was swallowed) and a self-skip keyed on `installedBy` — the
installer, never the agent — which made every human-installed agent wake itself
on its own board write. Both were reviewed independently by two readers. Four
tests came with them, including one named for this exact regression: *"skips a
HUMAN-installed agent editing the board, where `installedBy` could not."*

The re-land was then written **from the design**, not from the reverted tree. It
reintroduced the `installedBy`-keyed skip verbatim, comment and all. So the test
written to prevent the defect was deleted by the same operation that recreated
the conditions for it.

**Rule earned.** A revert is scoped by the commit it undoes, not by the defect it
targets. Everything that rode in on the same squash leaves with it, silently —
and squash-merge guarantees that "everything" includes every fix found during
review, which is precisely the work with no independent record. The re-land is
written from memory of the design, and the design never knew about the review.

**The guard is one command, and the obvious version of it fails.** Diffing the
re-land against the reverted commit at FILE level returns clean: every file in
the squash still exists in the re-land, because the re-land rewrote those files
rather than dropping them. Run on this incident it reports no difference while
four fixes and three tests are missing.

The check has to be at symbol and test-name level. On this incident that reads:

```
identityOf                             reverted=3  reland=0
actorIdentity                          reverted=2  reland=0
Number.isNaN(revTime)                  reverted=1  reland=0
getTime()                              reverted=1  reland=0
"skips a HUMAN-installed agent"        reverted=1  reland=0
"separates two writes 800ms apart"     reverted=1  reland=0
"matches identity case-insensitively"  reverted=1  reland=0
```

Noting the weaker version explicitly because it is the one a reader reaches for
first, and a guard that returns a clean pass on the exact case it was written
for is worse than no guard at all — it converts an open question into a
settled one.

**And the symbol-level check is triage, not a verdict.** Run against the merged
re-land it reported `identityOf=0, actorIdentity=0` — the same output as the
missing-fix case. The fix was there, reimplemented as `actorKey` with the same
semantics under a different name. A vanished fix and a renamed one are
indistinguishable in that output, so the check tells you where to read, never
what you will find. Treat a hit as an unanswered question; the answer is in the
diff.

Three false absences came out of that one instrument inside an hour, each with a
different cause: the symbol was RENAMED (`identityOf` → `actorKey`), the
surrounding code was DELETED so the symbol had nothing left to name (the rev key,
removed by coalescing), and the string differed in CASE (`HUMAN-installed` vs
`HUMAN-INSTALLED`). All three rendered as a zero that reads like a finding, and
all three were reported to peers before being read. A grep count is a coordinate,
not a claim.

**Test names are more durable than symbols and still not a verdict.** The obvious
repair — key the guard on test names, since implementation symbols get renamed —
fails on this same incident. The regression test came back as `skips a
HUMAN-INSTALLED agent editing the board, which installedBy cannot match`, from
`skips a HUMAN-installed agent editing the board, where installedBy could not`.
Case and trailing clause both moved, because rewording a test reads as harmless
in a way renaming a function does not. An exact-string check on test names would
have reported it missing too.

What closed this question was a peer who had read the merged tree saying which
names were there. No string check of any kind would have.

**What does work: a set difference over test names, as a worklist.** Not
string-presence — that is what made every row above misfire. Extract the test
names from the reverted suites and from the re-land, diff the two sets, and read
the residue. On this incident: 19 names before, 22 after, **five in the old set
unmatched in the new**:

```
carries a synthetic claim key, so one agent takes the task and the rest stand down
gives a later change to the same task a fresh key, or it collides with the settled claim
matches identity case-insensitively, since agentName is stored lowercased
separates two writes 800ms apart, which second-resolution stringifying merged
skips a HUMAN-installed agent editing the board, where installedBy could not
```

Every one resolves, and none is a loss: two were **superseded** (the claim key
is gone — coalescing folds on `payload.boardWake`), one **superseded with its
field** (the 800ms case tested a `rev` that no longer exists), two **renamed**
(`HUMAN-INSTALLED`, and the case-insensitivity test reworded).

The set difference is still a string comparison, and it flags the two renames as
unmatched exactly like the symbol check did. What changes is not accuracy — it is
two properties the string checks lacked.

First, **the false-alarm set is bounded**: five names over two known files, versus
six wrong rows out of seven across the whole codebase — and `getTime()` scoped to
one file returns 0 while the same grep over `backend/` returns 131. An unbounded
false-alarm rate is why nobody runs the check twice.

Second, **it cannot silently pass**. A string check returns zero and looks
like an answer. A set difference returns five names, each of which needs a human
to say *superseded, renamed, or lost*. It converts a verdict nobody validated
into a worklist somebody has to work.

**The near-miss worth recording.** The risk was flagged in the pod at the time —
"use `git revert` rather than a reset, so the re-land can cherry-pick them" —
and then nothing carried it. A note to a person is the same class of guard as a
tool description or a heartbeat instruction: it works only on someone already
being careful, which is the failure mode this file exists to document. The
flagging felt like the work and wasn't.

**Postscript: on this incident, nothing was actually lost.** The table above was
read at the moment the re-land branch was open, and every line of it resolved
differently by merge:

- `identityOf` / `actorIdentity` — **renamed**, not dropped. The fix shipped as
  `actorKey` with the same semantics.
- `getTime()` / `Number.isNaN(revTime)` — **superseded**. Coalescing removed the
  per-task claim key entirely, so the field the defect lived in no longer
  exists. Re-filing that defect now would target code that is gone.
- The three tests — gone with the field and the name they tested.

So the mechanism this entry describes is real and the example did not fire.
Recorded that way on purpose: an entry that says work was lost, when it was not,
teaches a reader to distrust the next re-land on evidence that never held. The
guard earns its place by making the question askable early, not by having caught
something here.

Related: entry 31's corollary (having found the dead tier, go read the live one).
Same shape — the diagnostic that finds a problem has to keep running past the
moment the problem is named.

---

## 34. The publish reached the registry and not the fleet

`@commonlyai/mcp@0.3.2` was published and verified — the tarball was unpacked
and grepped, and the new guidance was in it. Then the seats were restarted. The
change still did not reach the five agents it was written for.

They do not load the npm package. Their MCP config points at a **local staged
copy**:

```
~/.commonly/mcp-staging/commonly-mcp/src/index.js     ← still 0.3.1
```

`fable-lead`, `pod-architect`, `ux-lead`, `sprint-review`, `sprint-impl` — the
five seats doing the work, including the two whose 24- and 21-message runs
prompted the change. Publishing updated the registry and nothing any of them
reads.

**Why the usual check missed it.** The discipline that already exists here is
"smoke the shipped artifact, never repo source," and it was followed: version
confirmed on npm, tarball unpacked, content grepped. All three passed. That
discipline verifies the artifact is *correct* and says nothing about whether the
consumer *loads it*. Correct-and-unreachable passes every test aimed at
correctness.

**Rule earned.** After a publish, verify at the **consumer**, not the registry.
Concretely: find what the running process actually resolves — for these seats,
the `mcp-staging` path inside `~/.commonly/tokens/<agent>.json` — and check the
version *there*. A version number on npm proves a publish happened. It proves
nothing about what any particular seat loads.

**Same shape as the CLI, caught earlier the same day.**
`/opt/homebrew/bin/commonly` symlinks into a *git worktree*, not
`node_modules`, so `npm publish` never changes what the local fleet runs either.
Two packages, two different indirections, one wrong assumption: that the
documented delivery path is the actual one.

**The generalisation.** Six times in one day the thing being looked for
genuinely was not where it should be, and the capability arrived — or failed to
— by another route: heartbeat content (`heartbeatCue`, not
`enrichHeartbeatPayload`); reaction proof (the ledger, not a live watch);
mention autojoin (present, flag unset); workspace isolation (the spawn, not the
poller); the approval return leg (`postMessage`, not an enqueue); and this.
@sprint-review named it: *"the fifth absence tonight that was really a
redirection."*

The habit that follows: when a component is absent from where it belongs, the
next question is never "so the capability is missing" — it is "so what provides
it instead, and is that thing wired to the consumer I care about?"

---

## 35. A deploy's green tick is not the enforcement boundary

The consecutive-run cap shipped, `Deploy Dev` reported success, and the first
measurement showed a **9-message run inside the enforcing window**. Read
literally, the fix had failed.

It had not. The boundary was wrong.

```
deploy "succeeded" notification   ~21:50Z   ← what I split the data on
backend pod .status.startTime      21:53:26Z ← when the new code began serving
Pod Architect's 9-run              21:51:15 → 21:52:55
```

Kubernetes serves from the **old** pod throughout a rolling update. That run hit
a backend with no cap in it. Splitting on the real pod start:

```
BEFORE cap live (21:18 → 21:53:26):   2 runs exceeded 3,  longest 7
CAP ENFORCING  (21:53:26 →):          0 runs exceeded 3,  longest 3
```

42 messages, 18 runs, none over the cap — and the backend log shows it firing
three times, including on the seat that produced the original 24-run.

**Rule earned.** When measuring the effect of a deploy, take the boundary from
`kubectl get pod -o jsonpath='{.status.startTime}'`, never from the workflow's
completion time. The gap between them is a full rolling update, and everything
inside it is served by the previous image. A green tick means the *rollout*
finished, not that the new code was serving when your data was written.

**Why this belongs next to entry 34.** Same family: a signal that is genuinely
true (the deploy did succeed; the package was published) standing in for a
different question (was the new code serving *these* requests; does *this seat*
load it). Both would have produced a confident, wrong report — one saying a
working fix was broken, the other saying a change had shipped when no consumer
could see it.

**Worth recording that the change worked**, since an append-only failure log
teaches that nothing ever does: longest consecutive run **24 → 3**, while
message volume *rose* (0.70/min → 3.57/min). The room got busier and less
monologuic at once, which is the outcome the teammate goal actually wants —
agents still talking, no longer holding the floor.

---

## 36. The fleet's checkout tracks no revision (2026-08-20, sprint-review + fable-lead + pod-architect)

Entry 34 got as far as *"`/opt/homebrew/bin/commonly` symlinks into a git
worktree, not an npm install."* That is where I stopped too, and it is one layer
short. The worktree does not track a revision at all.

```
worktree HEAD          88495fd6   never moved in 24h, ~24 commits behind main
git status --porcelain 112 entries
                       M  cli/src/commands/agent.js
                       MM cli/src/lib/enforcement.js      <- the running governor
```

It is updated by checking **files** out into a dirty tree, never by moving HEAD.
So `git log`, `HEAD`, `git rev-parse`, and "N commits behind" are all false
instruments in that checkout, and they fail in the confident direction: they
return a real number, computed correctly, about a tree nobody is running.

**It broke three of my own claims inside 24 hours.**

1. *"The fleet is 23 commits behind, so #1047 and #1041 are absent."* The number
   was right and the conclusion was wrong for #1027 - that fix WAS on the seats,
   checked out as a file while HEAD stayed put. I told @ux-lead their refusals
   were opaque because #1027 never reached them. It had.
2. *"`enforcement.js` is byte-identical to `origin/main`, so the consumer side is
   current."* True when measured, false ninety minutes later when #1047 changed
   that file. A byte-identity claim carries an expiry and mine did not say so.
3. *"The seats are two commits stale."* By the next morning the file matched **no
   commit at all** - not main, not its own HEAD, not the previous state.

**What it actually matched was an unmerged PR branch.** On 2026-08-20 the file
on production disk was byte-identical to `origin/pr-1055`, a branch still OPEN,
still gated on two review findings, whose backend half did not exist on main.
The seats were running reviewed-but-unmerged bytes; the emitting half was absent,
so nothing fired. Benign by byte-identity and by ordering luck.

**The ruling that earns (@fable-lead):** the worktree sync is a deploy surface,
and it bypassed the merge gate - branch bytes on production disk with no commit,
no review state, and nothing for the next reader to diff against. **The fleet
syncs from main, post-merge, never from a PR branch.**

### The instrument that does work

Ask what the running process loaded, not what the repo says:

```bash
readlink -f "$(which commonly)"                            # find the real tree
git show <sha>:cli/src/lib/enforcement.js > /tmp/r.js
diff -q /tmp/r.js <worktree>/cli/src/lib/enforcement.js    # byte-diff vs NAMED shas
stat -f '%Sm' <file>                                       # when the file changed
ps -eo lstart,command | grep 'commonly agent run'          # when the process started
```

Diff against several candidate shas, not one: "matches none of them" is itself
the finding, and it is invisible if you only diff against `main`. Then order the
file mtime against the process start - **a file on disk is not a loaded module**,
and that gap is the one thing none of this can close from outside the process.

**Lesson.** In a deployment whose delivery mechanism is a file copy, revision
identity does not exist. Cite the bytes and the clock, never the ref. Entry 34
says a publish can reach a registry and not the fleet; this is the same failure
with no registry in it at all - and unlike a stale npm pin, nothing here is even
*wrong*, so nothing surfaces as an error.

Related: entry 34 (the publish reached the registry and not the fleet) and entry
35 (a deploy's green tick is not the enforcement boundary). Three delivery
surfaces, three different false instruments: a version pin, a workflow tick, and
a git ref.

### Addendum, 2026-08-22: the same surface, failing the other way

The entry above describes a worktree updated by file copy, where `HEAD` lies but
the files are current. Two days later the same surface failed inversely: nothing
was copied at all, and the running processes predated the fix regardless.

```
installed worktree   cli/package.json           0.1.15   (main: 0.1.16)
                     cli/src/lib/poll-retry.js  ABSENT
                     pollRetryPolicy refs       0
running seats        9 x `commonly agent run`   started Thu Aug 20 15:38-15:39
```

PR #1092 merged at 05:26:43Z and removed a retry loop that had already produced
797 consecutive `fetch failed` invisibly. Half an hour later every seat was still
executing the unfixed loop — including the seat that authored the fix. The CLI
reaches a seat by *publish -> worktree sync -> process restart*, and none of the
three had happened.

The nine start times are the whole diagnosis: they predate the PR by two days, so
no amount of syncing would have helped without a restart. This is the section
above's last caveat, measured — **a file on disk is not a loaded module, and here
no file was even on disk.**

A fourth false instrument to add to the three named above: **the merge itself.**
Backend fixes fail the same way through a different channel — #1096 merged at
05:23:55Z and was still not live an hour later, because the last `Deploy Dev` ran
from an earlier sha. Confirmed by prediction on a live row: a holder-authored
note extended the lease and left `rescueDeferrals` at 1, which is exactly the
pre-#1096 behaviour. Three channels, one symptom: not-published, not-deployed,
and published-but-not-loaded.

---

## 37. A fact is scoped to the surface you read it from, and expires

2026-08-21, pod-architect + sprint-review. Six instances in one working day,
each one a correct observation reported as a conclusion it did not support.

| what was read | what it was reported as | what it actually was |
|---|---|---|
| `gh api .../pulls/1077/reviews` → `[]` | "#1077 sat unreviewed for 2h" | reviewed at 10:16, posted **to the pod**, never to the PR |
| TASK-008 not under `assignee=sprint-impl` | "the assignee restore didn't land" | it landed at 10:34:59 and was **re-cleared** at 10:54:00 |
| `git show pr1078:models/Task.ts | grep rescueDeferrals` → empty | "#1078 silently reverts #1082" | the branch **head** predates #1082; the merge result carries both |
| `failed: 0` in the AgentEvent census | "no work is being discarded" | discard happens via the **pending GC** at `:715`, not the dead-letter |
| `kubectl get deploy clawdbot-gateway` → empty | "a stale gateway is running old tool contracts" | there is **no gateway** — the tier is parked |
| a written status summary | "here is the current state" | stale in the **37 minutes** between merge and writing |

Two distinct failures wearing one face.

**Scope.** Every query above was correct about its own surface and silent about
the adjacent one. GitHub's review API knows nothing about pod chat. A branch head
is not a merge result. `status: 'failed'` is one of two destruction paths and
`deleteMany({status:'pending'})` is the other, sixty lines below in the same
function. @sprint-review put the diagnosis best after finding the second
destruction path: *"I checked one of two destruction paths. I even reasoned
explicitly about delete-vs-mark — and then never asked the same question of the
retention sweep sitting sixty lines below."* The check was right; it was applied
once.

**Shelf life.** A status note describes a moving system from a fixed instant.
Ours went stale between the merge and the sentence about the merge — 37 minutes,
during which a peer merged the PR the summary listed as pending. The summary was
accurate when composed and wrong when read, and nothing in it said when it was
composed.

**Why the empty result is the dangerous shape.** Five of the six are *absences*.
An empty result and a broken instrument render identically, so the reflex has to
be a positive control before the absence is believed. Three times today a
control changed the conclusion: `git show pr1078:...Task.ts | wc -l` → 95 lines
(so the file is there and the fields genuinely are not, but on the *head*);
`kubectl get deploy -n commonly-dev` listing six other deployments (so the
namespace is reachable and the gateway genuinely does not exist); and re-running
a rescue census across `done` rows, which recovered 7 rescues a
`pending,claimed` filter had dropped along with the completed task that owned
them.

**The field you filter on is not the field that holds it.** A fifth instance,
contributed by @sprint-review — and the write-up below is the *second* attempt,
because they corrected the first one before it could ship.

`GET /api/v1/tasks/:podId?assignee=X` filters the stored `assignee`
(`tasksApi.ts:182`). A task is *held* by `claimedBy`. The list route offers
exactly three filters — `assignee`, `status`, `claimable` — and **none of them
asks "what am I holding."**

The two fields are not two views of one fact. They are different value spaces
written by different paths and never compared:

```
assignee   String, a NAME       "sprint-impl", "pod-architect"   set by whoever assigns
claimedBy  String, an ObjectId  "6a693cfce833c668acdcfbdc"       set by the claim CAS
```

The claim `$set` (`tasksApi.ts:421`) never writes `assignee` at all. So a seat
can hold a row and be absent from every query for its own name — and
@sprint-review ran their board checks that way for a day while holding
TASK-025, concluding they held nothing.

**What the first draft of this section got wrong, twice**, because the
corrections are the more useful record:

- It claimed the fields are *"normally equal"* and *"diverge after a rescue."*
  They are never equal — a name and an ObjectId — so there is no divergence
  event to point at. I wrote a plausible mechanism instead of reading the
  schema, having just verified the line numbers around it.
- It attributed the gap on TASK-025 to a rescue clearing `assignee`. That row
  was **created unassigned** (`"Created by pod-architect"`, no assignee), so
  the gap existed from the first claim and no rescue was involved. My own note
  on that row says so twice, and I still reached for the mechanism I had been
  thinking about all night.

The real shape is duller and worse: there was never a moment when
`?assignee=` would have found a held row that wasn't also separately
labelled. The filter answers a question about labels; the seat was asking a
question about custody; nothing in the API distinguishes them.

**And the obvious remedy is not free**, which @sprint-review raised 54 seconds
after @ux-lead proposed it — and then withdrew, correctly, when the precedent
turned out not to transfer. (The first version of this paragraph said they
flagged it *"before anyone proposed it."* That was wrong, and they corrected
it against their own credit while reviewing this entry.) `claimable` is deliberately absent from the MCP tool
schema, with the reason written at `tasksApi.ts:174`:

> Exposing it teaches every seat to poll the whole board on a timer — the
> surface is the guard, because a tool description isn't one.

A general `heldBy=<anyone>` filter crosses that line: it is a board view
wearing a custody name, and it would be used to find rows to race. A
`heldBy=me` resolved server-side from the caller's identity does not — there
is no board in the answer, so there is nothing to poll for. The distinction
is worth stating because the two look identical in a schema and differ
entirely in what they teach.

**The state that removes a row from every surface.** A fourth reachability
failure, distinct enough to name: `done` is not just a status, it is a
retirement from attention. Three instances the same day, none of them a wrong
query:

- A rescue census run as `status=pending,claimed` returned 15 events. Re-run
  across `done` it returned 22 — TASK-015 had completed at 13:54:31 and took
  its seven rescues out of the count with it. The number changed because the
  row moved, not because anything about the rescues did.
- @sprint-review's producer-parity audit — the evidence D1 of ADR-024 is built
  on — lived in **TASK-006's completion notes**, marked done 2026-08-18. It sat
  there undated for three days while four merged PRs falsified it, and nobody
  re-read it because nobody re-reads a done row.
- They had already named this exact hazard when creating TASK-023: *"carved out
  of TASK-014's F1, which is done — the finding was living in a completed task's
  notes, which is how findings evaporate."* Then left their largest finding in
  one.

The board's terminal states are built for *stop bothering me*, and they work:
`done` correctly removes a row from the kernel sweep's orbit, from found-work
advertisements, and from status-filtered queries. The cost is that it removes it
from readers too, and there is no state meaning **finished, but the knowledge in
here is still live**. A finding's shelf life is therefore capped by the lifetime
of the task that happened to surface it — which is arbitrary with respect to how
long the finding stays true.

The remedy is placement, not memory: a finding that outlives its task belongs in
`docs/` or an ADR *before* the task closes. Naming the hazard is not protection
— the person who named it did it anyway, three days later, with their best
finding of the sprint.

**When three readers converge on the wrong account.** The gitlink rollback in
#1089 is the cleanest instance, because nobody was careless and every
explanation was offered in good faith:

| reader | account | why it was wrong |
|---|---|---|
| @ux-lead | "not your doing — #1078 moved the pin, your checkout predates it" | the branch was cut from `origin/main` that morning, already at `5d88a3f1` |
| @sprint-review | "the existing guard already catches this" | containment passes a *former* pin: `compare/70bd82b8...5d88a3f1` → `behind_by=0` |
| pod-architect | agreed with both before checking either | — |

Three accounts, all plausible, all pointing away from the defect. The true
cause was in none of them: `git add -A` in a checkout whose submodule sat at an
older commit, staging a stale pointer as an intentional edit. The author typed
no submodule command, so no explanation that assumed intent could reach it.

What broke the convergence was one command that could have returned either
answer — `git merge-base --is-ancestor`. Not more scrutiny, and not a fourth
opinion: a check whose result was not implied by the story being told.

The hazard this names is specific. A wrong account offered *in your favour* is
harder to test than one offered against you, because accepting it costs
nothing in the moment and the social gradient runs toward agreement. Both of
these ran toward the author, and the author took them.

**The habits that follow.**

1. Name the surface in the claim. "GitHub shows no review" is reportable;
   "it was unreviewed" is not.
2. Before believing an absence, run a positive control that would have produced
   output. If you cannot construct one, you cannot report the absence.
3. When a check saves you once, ask what else in the same function it applies
   to. The second destruction path is usually adjacent to the first.
4. Never diff a PR head to reason about a merge. Compute the merge
   (`git merge-tree`) — a two-way diff against a branch tip is a different
   question wearing the same clothes.
5. Timestamp status summaries, and re-read the room before restating a plan.
   A plan repeated without re-reading is a claim about the present made from
   memory of the past.
6. Date every audit quote at the point of quoting it, and move a finding out of
   a task row before completing the row. `done` retires a fact from every
   surface at once, including the ones you will search later.
7. Test an exculpatory account exactly as hard as an accusatory one. Agreement
   is not evidence, and a plausible story that lets you off costs nothing to
   accept and everything to be wrong about.
8. Apply a precedent by its stated harm, not its subject. @sprint-review's
   own framing, after withdrawing an objection they had raised correctly and
   scoped wrongly: `tasksApi.ts:174` keeps `claimable` out of the MCP schema
   because *"exposing it teaches every seat to poll the whole board on a
   timer."* Read by subject — *a filter on the task list* — it blocks any new
   filter. Read by harm — *board-wide scanning for other people's work* — it
   blocks `heldBy=<anyone>` and permits `heldBy=me`, because there is no board
   in that answer. A precedent whose reason is written down can be scoped by
   that reason; one whose reason is not written down can only be applied by
   resemblance, which is how a guard becomes a general prohibition nobody
   chose.
9. Prefer a checkable claim to silence. A cue, comment or doc that states
   something falsifiable is an instrument: someone can hold it against the code
   and find the gap. Deleting the claim to stop it being wrong deletes the
   detector and leaves the defect. @sprint-review reached this while withdrawing
   their own proposal — the kernel's lease cue named two renewal paths as
   equivalent, they weren't, and *that discrepancy is how the bug was found*.
   Rewording the cue to mention only the working path would have removed the
   one artifact capable of exposing the other.


## 38. Two write routes, one contract — and only one delivers (2026-08-22, operator session)

`POST /api/pg/messages/:podId` and `POST /api/messages/:podId` accept the same
body, require the same auth, write to the same `messages` table, and return
the same-shaped row with a 200. One of them runs the mention pipeline
(`enqueueMentions` → agent events → native runs → wake-on-message). The other
persists the row and returns.

An operator script asked `@recorder` a question through the PG-prefixed route.
The message appeared in the pod, humans could read it, wrapper seats saw it on
their next context read — and the mention reached zero agents, because
`pgMessageController.createMessage` has no mention code at all. Two asks were
silently swallowed before the missing `agentDelivery` field in the response
gave it away.

**This is the second bite.** The 2026-08-15 silence alert (#954) found the
same class on a sibling route. The route survived because nothing about it
looks broken: the 200, the row, the socket echo are all real. The only
distinguishing signal is a field that is *absent* — and an absent field reads
as "older response shape," not "your message reached nobody."

**Rules earned.**

- A message write route that skips the mention pipeline is not a smaller
  version of the real one — it is a different thing wearing the same
  signature. Either route it through the mention-aware controller or delete
  it (TASK-039). A second copy of `createMessage` is a copy, and copies
  drift.
- Delivery must be **positively visible in the response**. `agentDelivery`
  present-with-zeros says "nobody was mentioned"; `agentDelivery` absent
  must not be a possible output of a healthy send. A caller cannot act on
  the absence of a field it doesn't know exists.
- When an agent doesn't respond to a mention, check the POST response for
  `agentDelivery` BEFORE reading agent-side logs. Thirty seconds there beats
  the twenty minutes this cost tracing runs, events, and a just-landed
  deploy that had nothing to do with it — proximity to a deploy makes every
  bug look like a regression.

## 41. A conflicting PR's checks describe a tree that will never exist (2026-08-22, pod-architect + sprint-review)

> Numbering assumes #1122 (entry 39) and #1132 (entry 40) land first. If they
> merge in a different order, renumber this one rather than them.

Three stacked threading PRs sat at heads I had just pushed. Their pages showed
green ticks. I reported them as green in a task update. All three reports were
wrong, in two different ways, and both ways look identical to a passing build.

**What was actually true.**

`#1109` had squash-merged at 18:50:59Z. At ~18:55 I pushed two more commits to
its branch — a real fix, with tests. The branch ref moved; the PR was already
closed, so nothing dispatched and nothing merged them. `gh pr view` kept
reporting `headRefOid` as the pre-merge commit, so the PR page showed a full
green rollup **for the parent commit**, three commits behind the branch.

`#1120` and `#1128` were `CONFLICTING/DIRTY`: `main` had taken the squashed
2/4 while their branches still carried the unsquashed originals. GitHub builds
`pull_request` events against a *merge ref*, and a PR that is conflicting **at
the moment of the event** has none — so `tests.yml` did not dispatch. What
remained was CodeQL, which triggers on `push`, needs no merge ref, and passed.
**Four checks, four green ticks, zero tests.**

Measured, because the first draft of this entry said "a conflicting PR never
dispatches tests" and @sprint-review falsified it by finding eight green runs
— Tier 1 among them — on `3f31d103`, a conflicting head. Their measurement was
right and the sentence was wrong. Timestamps settle it:

| Head | Pushed | Conflict began | `pull_request` dispatched? | Runs (unique names) |
|---|---|---|---|---|
| `9366e11e` (#1120) | 18:53:21Z | 18:50:59Z, not yet computed | yes | 11 (11) |
| `4942ad3d` (#1120) | 18:57:12Z | known by then | **no** | 4 (4) — CodeQL family only |
| `3f31d103` (#1136) | 19:38:29Z | 19:44:07Z, six minutes later | yes | 8 (5) — 5 `pull_request` + 3 `workflow_dispatch` |

The last row said "11 checks" in the first version of this entry. @sprint-review
measured it at 8 runs across 5 names and was right — and it was a number I had
myself counted correctly earlier the same hour before contradicting it here.
The duplication is sprint-impl's manual re-dispatch landing on the same sha as
the automatic run, so a name-count and a run-count disagree by three.

The two PRs' `pull_request` sets also differ in **membership**, 11 names
against 5, not merely in size. I left that labelled as an unchased hypothesis;
@sprint-review measured it, and re-deriving it confirms the 5 are a strict
subset of the 11 with exactly six extras:

```
CodeQL · Analyze (actions) · Analyze (javascript-typescript) · Analyze (python)
Source changed ⇒ version bumped · Stale-base merge guard
```

Two are merge-to-main guards and are correctly base-scoped — both
`package-version-guard.yml` and `pr-base-freshness.yml` declare
`pull_request: branches: [ main ]`, so a PR onto a feature branch is outside
their remit by design. The other four are CodeQL's, and there is no
`codeql.yml` in the repo: that is GitHub default setup, scoped outside our
workflow files entirely.

**Which means a PR's "full" check set is a property of its BASE, not of the
repo.** There is no fixed number to compare against. Eleven is complete for a
PR onto `main`; five is complete for a PR onto a feature branch; and a stacked
PR that gets retargeted to `main` at merge time will be judged by guards that
never ran on it. Counting checks tells you nothing unless you know what the
denominator should have been — which was the mistake one paragraph up, made
in an entry about exactly this.

**And base is necessary, not sufficient — the CHANGED PATHS move it too.**
Found by applying the paragraph above to this very PR. `#1135` is docs-only,
targets `main`, and reports 10 checks against `#1120`'s 11; the missing one is
`E2E Tests`, because `playwright.yml` filters on
`frontend/** · backend/** · e2e/** · playwright.config.*` and a `docs/**` diff
matches none of them. The workflow never dispatches, so the check never exists.

**I then attached a consequence to that finding which was false, and it is
worth keeping the wreckage visible.** I wrote that a docs-only PR therefore
settles at `MERGEABLE/UNSTABLE` permanently, that no future event produces the
absent check, and that a "merge only when CLEAN" rule would deadlock on
documentation. I posted that to the pod as something to act on.

It is wrong. Waiting for the runs to finish and re-reading:

```
#1142  MERGEABLE/CLEAN   checks=10  E2E absent
#1143  MERGEABLE/CLEAN   checks=10  E2E absent
```

An absent `E2E Tests` does not prevent `CLEAN` — it is not a required check,
so its non-existence costs nothing. The `UNSTABLE` I had seen on `#1135` was a
check still **pending**, not a check **missing**, and it resolved on its own.

So the mistake was reading a transient state as a structural one, and then
inventing a mechanism to explain it. The invented mechanism was internally
coherent — paths filter, no dispatch, no check, never CLEAN — which is exactly
what made it convincing enough to commit and to broadcast. Every step was true
except the one connecting them to the observation.

The membership finding above survives intact and was independently verified
from `playwright.yml` and from `E2E=0` on all three PRs. Only the consequence
was fabricated.

So the denominator is a function of *(base, paths touched)*. Three of this
entry's corrections have now come from treating a check count as comparable
across PRs that were never comparable.

**So there are two mechanisms, not one, and the second is the worse of them.**

1. *Push while the PR is known-conflicting* → no `pull_request` dispatch. The
   checks that appear are the push-triggered ones. This is what hit `4942ad3d`.
2. *Become conflicting after the checks ran* → every check stays attached to
   the sha, still green, now describing a state that no longer exists. Nothing
   re-runs, because nothing was pushed. This is what hit `3f31d103`, and it is
   what makes the first mechanism look false to anyone who measures afterwards.
3. *The base auto-retargets when the parent merges* → **no event fires at all.**
   Named in advance by Sam (56969) from an 2026-08-04 incident, and confirmed
   here: `#1106` merged at 15:15:08Z, GitHub retargeted `#1109` from the parent
   branch to `main`, and the next workflow run on that branch was at 15:53:20Z
   — 38 minutes later, triggered by a push, not by the retarget. Zero runs at
   15:15.

**Why nothing fires, not just that nothing fired.** @sprint-review (57010)
supplied the cause behind the measurement, and re-deriving it confirms every
part. A base change emits `pull_request.edited`, and **no workflow in this repo
subscribes to `edited`** — `grep -rn 'edited' .github/workflows/` returns
nothing. Three declare their types explicitly:

```
release-safety.yml         [opened, synchronize, reopened, ready_for_review]
package-version-guard.yml  [opened, synchronize, reopened, ready_for_review]
pr-base-freshness.yml      [opened, synchronize, reopened]
```

and the four others on `pull_request` — `tests.yml`, `playwright.yml`,
`secret-scan.yml`, `mintlify.yml` — take GitHub's default set, which is the
same list minus `ready_for_review`. `edited` is in none of them. So the
retarget does fire an event; it fires one that nothing is listening for, which
is why `update-branch` works and a base flip does not: the former pushes a head
commit and produces `synchronize`.

Stated precisely, because the two halves have different evidence: *zero runs at
the retarget* and *no subscriber to `edited`* are both measured here. That
GitHub emits `edited` specifically on a base change is from its documentation,
not from an event payload I captured — consistent with the observation rather
than demonstrated by it.

**The root fix exists and is probably not worth taking.** Adding `edited` to
those `types` lists would make a retarget re-run CI on its own. It would also
re-run CI on every title and body edit, since `edited` covers those too. That
is a bad trade on a busy repo, so the mitigation stays where Sam put it: force
a head event deliberately. Worth writing down that the alternative was
considered and declined, or the next reader re-derives it.

4. *The base branch predates the workflow fix* → the fix never applies. For a
   `pull_request` event GitHub reads the workflow definition from the **merge
   ref**, which is base + head — so the BASE branch's copy of the file decides
   whether the event matches. `#1123` dropped `branches: [main]` from
   `tests.yml` on main at 15:20:27Z, and `#1132` still got zero test runs from
   a head pushed at 18:11:30Z, three hours later, because its base
   (`docs/ax-two-call-sites`, last touched 06:52) still carries the old
   filter. Verified by reading `tests.yml` on that branch.

   Its whole check list is one skipped `Release Branch Guard`, and its
   `mergeStateStatus` is `CLEAN` — nothing failing, because nothing ran.

   **ATTRIBUTION, corrected.** @sprint-review established this mechanism at
   15:25:50Z — including "the trigger is read from the PR's own merge ref" —
   measured on `#1120`, whose head was pushed 15:22:21Z, two minutes after
   `#1123` merged, and produced zero runs for the same reason. They also
   corrected their own earlier "merge #1123 first and the ordering stops
   mattering" in the same message.

   I derived it independently nine hours later from `#1132` and posted it as
   "they measured the counts and declined to claim the cause; this is the
   cause." That was wrong. They claimed it, first, and correctly; their
   message was sitting unread in my redelivery queue while I re-derived it.
   Two instances, two PRs, one mechanism — theirs is the finding and mine is
   the confirmation.

   **Read `event`, not the count, when asking whether a fix reached a PR.**
   @sprint-review (57058) measured zero runs on `#1120`'s `0147fa24`, then one
   run six minutes later — a flip that reads exactly like "my earlier claim
   was wrong, #1123 did reach it after all." It was my hand-dispatch landing
   between their two checks. The discriminator is the `event` field:
   `workflow_dispatch` proves someone pushed a button, `pull_request` proves
   the trigger matched. Only the second is evidence about the fix.

   This is worth more than the instance because a manual dispatch is the
   standard response to noticing a PR has no checks — so the act of working
   around the bug produces exactly the artifact that makes the bug look
   absent, and the person most likely to measure afterwards is the one who
   dispatched. Both counts in the table above are split by event for this
   reason.

   **A workflow fix on `main` reaches a stacked PR only when that PR's BASE
   absorbs it.** Not the head — the base. So "we fixed CI for stacked PRs" is
   true of the repo and false of every PR already stacked on a stale branch,
   and there is no signal distinguishing the two.

   I got this wrong twice before reading the file. First guess: the head
   predated the fix (refuted by timestamps — it postdates it by three hours).
   Second: a paths filter (refuted — `tests.yml` has none). Rule 16's "make
   the mechanism predict something" is what killed both.

Mechanism 3 is the worst of the three for a stacked PR, because nothing about
it looks wrong. There is no conflict, no thin check list, no red. The PR is
green and mergeable — and it now means something different from what was
tested, since it merges into `main` rather than into its parent branch, and
every check on it was computed against the old base. A green rollup is exactly
what you would expect to see, and exactly what you get.

The second is worse because the first at least leaves a thin check list as a
hint. The second leaves a **complete, genuinely-passing rollup** on a
PR that can no longer be merged and whose tests have never run against the
tree it would produce. There is no artifact anywhere that says so.

Note the window in row 1: `9366e11e` was pushed 142 seconds after the merge
that broke it and still got a full dispatch, because GitHub had not recomputed
mergeability yet. Whether your push lands before or after that recomputation
decides which mechanism you get, and nothing in the UI marks the boundary.

**Why the instrument can't tell you.**

Both failures are absences. A commit with no check runs has no failures. A
workflow that never dispatched leaves no red X — it leaves nothing, and the UI
renders nothing as clean. The rollup is a fold over the checks that exist; it
has no opinion about the checks that should exist. Reading it answers "did
anything fail," which is not the question — the question is "did the suite run
on *this* commit."

The same shape has now been recorded here four times under different names
(entries 34, 35, 37). It keeps recurring because every instance is a status
read against the wrong object: the registry instead of the consumer, the
workflow's clock instead of the pod's, the parent commit instead of the head.

**Rules earned.**

- **Verify by sha, not by PR.** `gh api repos/:o/:r/commits/<sha>/check-runs`
  and compare the sha you queried to the branch tip you pushed. A PR's
  `headRefOid` can lag its own ref, and on a merged PR it stops updating
  entirely. If the count of check runs is zero, that is the loudest possible
  signal, and it prints as silence.

  **And if that comparison keeps failing, stop pushing rather than
  re-dispatching.** @sprint-review (57014) caught this branch taking four heads
  in twelve minutes against a `tests.yml` that runs 5–6 — a cadence under the
  suite's runtime means no run can ever land on the tip, and every fix looks
  like one more dispatch away. The rule above detects the mismatch; only
  noticing the *rate* tells you why it will keep recurring. Green-on-head needs
  a quiet period.
- **Check `mergeable` before reading `statusCheckRollup`.** On `CONFLICTING`
  the rollup is either a smaller set than you think (mechanism 1) or a full
  set measured against a tree that no longer exists (mechanism 2). Neither is
  evidence about what merging would do. Read the two together or neither —
  and note that a *complete* green rollup on a conflicting PR is the worse
  signal, not the reassuring one.
- **A squash merge orphans anything pushed to that branch afterwards.** The
  window is as long as your commit takes. Before pushing to a branch you
  believe is open, confirm it: a closed PR accepts the push, moves the ref,
  and reports nothing. Recovery is a cherry-pick onto a fresh branch off
  `main` — cheap, but only if you notice.
- **A stack does not survive its own base squash-merging.** The child now
  conflicts on every file the squash touched, and — per the above — goes
  quiet rather than red. Rebase children onto `main` immediately after a
  parent lands; do not wait for a review to surface it, because the review
  will be looking at the same green ticks.
- **A retargeted PR needs a new head event before its checks mean anything.**
  Sam's press plan (56969) is the working form: merge the parent, verify the
  child's `baseRefName` actually flipped and the PR did not auto-close, then
  force a head event (`gh pr update-branch`) so CI runs against `main`. No
  stacked PR merges without its own green run *at the new base*.
- **You can tell which base a run was against, from the run list.** The
  base-scoped guards are the tell: `Package Version Guard` and
  `PR Base Freshness` both declare `pull_request: branches: [ main ]`, so their
  PRESENCE certifies the run happened with `main` as base and their absence
  says it did not. That is how `#1109` was confirmed to have satisfied the rule
  before it merged — both guards appear in its 18:30 run, three hours after the
  retarget. Reading the check *names* answers a question the check *count*
  cannot.

## 42. A dual-auth route degrades to the other identity silently, so a test can name a shape it never exercises (2026-08-22, sprint-review + pod-architect)

> Numbering follows entry 41's caveat: 39 and 40 are still reserved by #1122
> and #1132. Renumber this one, not those, if they land in another order.

`/api/v1/tasks` does not take one auth middleware. It dispatches on the token:

```ts
function auth(req: AuthReq, res: Res, next: () => void) {
  const token = ((req.header?.('Authorization') || '').replace('Bearer ', ''));
  if (token.startsWith('cm_agent_')) return agentRuntimeAuth(req, res, next);
  return regularAuth(req, res, next);
}
```

The two branches produce **different request shapes** — `agentRuntimeAuth`
assigns `req.agentUser` and never `req.user`; the human path does the reverse.
And the fallback is unconditional: a request with no `cm_agent_` prefix does
not fail, it takes the human branch and succeeds. Omitting the header is
indistinguishable, from the response, from supplying it.

**What that costs a test author.** Every case in
`tasksApi.updateRenewsLease.test.js` went through the human mock, so
`req.user` was always populated and the agent branch had never run — across
two rounds of fixes to code whose whole subject was the agent identity. The
first draft of the tests written specifically to cover the agent shape
*also* went through the human path, and passed. A test can carry "agent" in
its name, assert the right thing, go green, and be about the other identity
entirely. The only tell is a header the test does not have to set.

**Why this is an agent-experience defect and not a testing anecdote.** The
false model is taught by the surface, not by the test: a route named `auth`,
mounted once, reads as one identity contract. Nothing at the call site says
"this endpoint has two request shapes and picks between them by string
prefix." Three of the day's four wrong conclusions trace to reading `req.user`
on a path that only ever populates `req.agentUser` — including
`resolveAgentInstanceId`, whose `req.user?.isBot` gate has been dead on the
agent path since it was written.

**What to do.**

- **Setting the auth header is part of naming the shape.** A test whose
  subject is the agent path must send `Bearer cm_agent_*`; without it the name
  is the only agent-specific thing in the test. Assert the shape arrived
  (`expect(req.agentUser).toBeDefined()` in the mock, or one case that must
  fail on the human path) rather than trusting the route to have chosen.
- **A silent branch needs a loud test.** Where a dispatcher falls back rather
  than erroring, at least one case must prove the fallback did *not* fire.
- **Grep the middleware, not the docstring, for which property is assigned.**
  `agentRuntimeAuth` assigns `req.agentUser` at `:102` and `:191` and nowhere
  else — one grep, and it settles every question of this shape.
- Companion rule, on the method that missed it: reviewer-checklist rule 17 —
  a mutation proves a term matters to the suite, not that the suite's shape is
  real.
