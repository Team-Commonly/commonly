# What a squash merge lands

A squash merge writes **one** commit to main. Its message is composed from two
surfaces — the branch's **commit messages** and the **PR title** — and *which one
supplies the subject is decided by the repository setting, on the count of
non-merge commits*. The PR *body* is not an input at all.

The setting is readable, and reading it makes the composition decidable without
waiting for a merge:

```bash
gh api repos/Team-Commonly/commonly \
  -q '{squash_title: .squash_merge_commit_title, squash_message: .squash_merge_commit_message}'
# {"squash_title":"COMMIT_OR_PR_TITLE","squash_message":"COMMIT_MESSAGES"}
```

`COMMIT_OR_PR_TITLE` means **one commit → that commit's subject; two or more →
the PR title**. `COMMIT_MESSAGES` means the body is the branch's commit
messages, always. Both counts skip **merge commits**, which matters on any branch
that merged main into itself — see below.

This is the **default** composition, not a law. The presser can set the subject
at the press — GitHub's merge dialog exposes the box, and `gh pr merge -t/--subject`
sets it from the CLI — and an override is detectable: it is a landed subject that
the setting and the non-merge count do not predict. Three are
measured [below](#an-override-exists--and-it-is-measurable).

## The composition

| PR shape (the default) | landed subject | landed body |
|---|---|---|
| **1 non-merge commit** | the **commit's** subject + ` (#N)` | that commit's message **minus its first line** |
| **2+ non-merge commits** | the **PR title** + ` (#N)` | per commit, in order: `* <full commit subject>`, a blank line, then that commit's message body |

A merge commit on the branch is **excluded from both**: it is not counted when
choosing the subject and it gets no `* ` bullet in the body. Measured on four
branches that merged main into themselves — #1965 (7 non-merge + 1 merge → **7**
bullets), #1901 (6 + 1 → 6), #1905 (5 + 1 → 5), #1906 (4 + 1 → 4) — and on
**#1964**, whose branch carries **1 non-merge commit + 1 merge commit** and whose
landed message is in the **one-commit** shape, the commit's subject with no
bullets at all.

## What the census shows

Measured over **the 297 merged PRs numbered #1750–#2053** (`gh api
…/pulls?state=closed`, each merge commit read with `git log -1 --format=%B`). That
range is contiguity-checked: of its 304 numbers, **302 are pull requests** — 297
merged, 3 closed unmerged (#1784, #1903, #1967) and 2 open (#1751, #1768) — and
**2 are issues** (#1821 closed, #1959 open), each checked with the `pull_request`
key on `gh api …/issues/N`. The original fetch, capped at 300 rows *sorted by
updated*, missed three of the merged ones inside it (#1752, #1753, #1765); each
was read afterwards and all three are conforming. Restricted to the
**discriminating** set —
the 82 PRs whose PR title and first commit subject differ, which is the only set
where the two candidates for the subject can be told apart:

| non-merge commits | landed the **commit's** subject | landed the **PR title** |
|---|---|---|
| **1** | **33 of 33** | 0 |
| **2+** | 0 | **49 of 49** |

The classifier is the count of commits with fewer than two parents; `gh pr view
<N> --json commits` counts merge commits too and will call a one-commit branch
"2 commits". That single mis-classification produced the only apparent exception
in an earlier draft of this census (**#1964**, above) and with it a residual
"unexplained" case that was really a classifier artifact.

Across the nine PRs this pod landed between 09:08:43Z and 09:19:20Z on
2026-09-30, **six had `title == first commit subject`**, so they cannot
distinguish the two surfaces and say nothing about which one won. The three that
discriminate are all the rule:

| PR | non-merge commits | landed subject |
|---|---|---|
| #2024 | 2 | the PR title + ` (#2024)` |
| #2049 | 2 | the PR title + ` (#2049)` |
| #2031 | **1** | **the commit's** subject + ` (#2031)` |

The body shape is a second, independent classifier — a multi-commit landing emits
one line-initial `* ` per non-merge commit — and it agrees: 0 exceptions across
this set. It is the weaker of the two, because a bulleted line inside a
*one-commit* PR's commit body would look multi; in this population it does not
happen (0 of the 33 one-commit landings contain a line-initial `* `), but when
the answer matters, count the non-merge commits.

Within that window **no landing needs an override**: the 82 discriminating rows
all take the surface the count predicts, and the other 215 rows, where the two
candidates are identical, all landed that shared text — which an override would
have displaced. That window is why this census is a claim about 297 landings and
not about the practice; the next section measures an older window where
overrides do occur.

## #2031 was the one-commit default, not an overwrite

#2031 has one commit, and its PR title differs from that commit's subject
(`… (TASK-204 late delta)`). Its landed subject is the **commit's** own subject
with ` (#N)` appended. An earlier draft of this doc read that as the presser
overwriting the subject box, and inferred a general rule ("the box is editable,
so the title is not what landed") from a single case that the setting already
explains. That inference was the error, not the observation: **under this setting a
one-commit PR takes its subject from the commit, so #2031 is the default in
action** — *default*, not "always": #1623 below is a one-non-merge-commit branch
that landed its PR title.

## An override exists — and it is measurable

The subject at the press is editable — the merge dialog's box, or
`gh pr merge -t/--subject` — and it **has been used**.
Measured in an older window — **194 merged PRs, #1534–#1749**, against **zero**
in the 297 above — three landings took a subject the setting does not predict,
all three merged on **2026-09-08**:

| PR | non-merge (+ merge) commits | landed subject | how it relates to the two candidates |
|---|---|---|---|
| #1645 | 1 (+0) | matches **neither** | equals **neither** the PR title nor the commit's subject; 0 rename events |
| #1623 | 1 (+3) | the **PR title**, byte-exact | equals a candidate; the count predicts the commit's subject |
| #1644 | 2 (+1) | **commit 1's** subject, byte-exact | equals a candidate; the count predicts the title |

All three fail the prediction. What separates them is whether a **stale prefill**
could account for the landing instead of an edit: a merge dialog seeding its
subject field when it *renders*, so that a box opened while the branch held fewer
commits is pressed carrying an older subject. **That mechanism is inferred, never
read** — no API field records which client pressed or what the box held — and
every bullet below inherits the hedge.

- **#1623 cannot be explained that way — on a premise that is inferred, not
  read.** Its branch held exactly **one non-merge commit for its whole life** —
  three main-merges followed it — and the timeline records **0 force-push
  events**. The measured rule is about what *lands*: a branch with one non-merge
  commit lands the **commit's subject**. If the dialog prefills by that same
  count, no render of it could have offered the title, and it landed the title,
  byte-exact. **No prefill has ever been read**: if the dialog counts merges,
  #1623 needed no edit, and the five merge-carrying landings below become the ones
  to explain.
- **#1645 cannot be explained that way either**: one commit, no merges, and a
  landing matching *neither* candidate.
- **#1644 can**: commit 1 landed 20:24:15Z, commit 2 20:29:26Z, and the press
  20:52:58Z, so a dialog rendered inside that five-minute window prefilled commit
  1's subject and was pressed stale. Available, and unverifiable from the API —
  which is why this row is evidence the *prediction* can fail, not evidence of an
  edit.

That the rule counts **non-merge** commits even when merges are present is what
makes #1623 an override rather than a conforming multi-commit landing, and it is
measured directly in the same window: **five** branches carrying main-merges landed
the **commit's** subject where counting every commit would have predicted the title
— #1678 (1 non-merge + 1 merge), #1647 (1 + 2), #1574 (1 + 1), #1558 (1 + 2),
#1539 (1 + 1). #1647 is the shape #1623 has, landing the other way.

The alternative reading — that the setting was something else on 2026-09-08 —
does not survive the same window: **33 of its 96 discriminating landings took the
commit's subject, 32 of them on a branch holding one non-merge commit** (the 33rd
is #1644 above), and a PR-title setting produces none of those without an override
each. The setting was `COMMIT_OR_PR_TITLE` there too, which is what makes the
three rows above overrides rather than a different rule. The other 98 rows of that
window have `title == first commit subject` and cannot discriminate at all.

So an override is detectable: **a landed subject the setting and the non-merge
count do not predict** — matching neither candidate (#1645), or matching the
candidate the count rules out (#1623, #1644). Where a stale prefill is unavailable
the box is what remains: for #1645 outright, and for #1623 on the inferred premise
above. The census
above supports a claim about *its own window*, not about the practice: 0
overrides in the 297 landings of #1750–#2053, 3 in the 194 of #1534–#1749. A
landed subject is never evidence about the PR title either way, and the merge
commit is the only reader that settles what landed.

## Why the commit messages are the surface that always bites

The body is always the branch's commit messages, and for a one-commit PR the
subject is a commit message too. So a claim that must not land is fixed in the
**commit message** first, and only then on the PR title — and specifically:

- **1 non-merge commit:** the commit message supplies **both** the subject and
  the body. A wrong PR title changes nothing that lands; a wrong commit message
  changes everything that lands.
- **2+ non-merge commits:** the **title** supplies the subject, the **commit
  messages** supply the body. Fixing the title does not fix a body claim, and
  amending the tip does not fix an earlier commit's text.

Nothing else reaches either surface: a PR *body* edit is not an input to the
composition at all, and a PR comment reaches neither.

**Amending the tip does not amend earlier commits.** Measured on #2049, whose
branch carried two commits with the tip amended to retract an over-claim: main's
merge message today carries both texts, side by side —

```
line 13: `split('@media (prefers-reduced-motion')[1]` is 865 lines / 33,883 characters
line 58: right; calling it "fiction about the code" was the wrong reason, and is retracted.
```

— the retracted framing in commit 1's body and its retraction in commit 2's, in
one message. `git log -1 --format=%B <merge>` is the only reader that shows
this. The PR page shows the current branch state, which is what the author last
saw; main shows what landed.

## Checking what landed — and what will land

```bash
PR=2049
M=$(gh pr view "$PR" --json mergeCommit -q .mergeCommit.oid)   # the merge commit, by identity
git log -1 --format=%s "$M"      # the landed subject
git log -1 --format=%B "$M"      # the landed body — the surface main reads
gh pr view "$PR" --json title -q .title                     # the subject for a 2+-commit PR
gh api repos/Team-Commonly/commonly/commits/<oid> -q .commit.message   # lossless branch message
```

Resolve the merge commit from the PR, never by grepping a message for `(#N)`.
Measured: `git log --format=%H --grep="(#1677)\$" -1 origin/main` returns
`de5fc4d83e`, while #1677's merge commit is `f8ad3bde6a` — both end with
`(#1677)`, because a *later* commit on main also names that PR, and there are two
such commits. The same happens for #1877 (`8235be3d2f` returned,
`e3d95501a1` actual). A grep for a string that other messages legitimately
contain fails by returning a plausible wrong commit, which is worse than
returning nothing.

To predict the subject before the press, count the branch's **non-merge**
commits, because that count — not the title — picks the surface:

```bash
gh pr view "$PR" --json commits -q '.commits[].oid' | while read oid; do
  gh api repos/Team-Commonly/commonly/commits/$oid -q '.parents|length'
done | sort | uniq -c     # parents == 1 is a non-merge commit; 2 is a merge and does not count
```

Reading the branch's **own** commit is a separate instrument, and it needs a
range. `git log --no-merges -1 <ref>` means "the newest non-merge commit
*reachable* from ref", walking *through* merge commits into everything they merged
in — and once main is reachable that way, the read can return main's commit
instead of the branch's. In the **22 merge-carrying rows of the #1534–#1749
window** — one non-merge commit each, and a merge tip on every one of them —
**21 returned a *different* commit**: #1623 → `feat(seo): add AI agent stop
conditions guide (#1626)`, #1574 → `… (#1576)`, #1647 → `… (#1651)`, #1558, #1539
and #1678 likewise, and fifteen more. The one quiet row is **#1651**, quiet for
the same reason #1964 survives below: its own `1270011e` (05:26:06-07:00) is
*newer* than the tip it merged in, `f3ae3798` (00:49:19-07:00), so the date-ordered
walk never leaves the branch. Coincident candidates are not what makes a row
quiet — 15 of the 16 rows here whose title equals their first commit subject are
among the 21 that fire. Range it from the merge base, or read each commit object
through the API:

```bash
git log --no-merges --format=%s "$(git merge-base origin/main "$REF")..$REF"
```

A merge tip is **necessary but not sufficient**, and **#1964** — from the 297-row
window, not the 22 above — shows why. Its tip `3e7ce46a` *is* a merge — parents
are its own `3a658321` (11:17:28Z) and the merged-in `ff8de0fa` (11:16:48Z) — and
the unranged read still returns #1964's own commit, because the walk is
**date-ordered** and that commit is **40 seconds newer**. #1623 has the same shape
and loses the same race by **30 minutes**: its own `a9c6cb28` at 06:55:46Z against
main's `9f759062` (#1626) at 07:25:57Z, which is the whole reason the unranged
read hands back the SEO guide. So **#1964 is a near miss, not a control** — which
commit a merge tip yields is decided by timestamps, and a 40-second margin is not
something a reader can check. The clean control is a tip that is **not** a merge,
with the branch's own commit the newest thing reachable: measured on #2051, #2053,
#1752, #1753, #1765, #1645 and #2031, one parent each, `origin/main` an ancestor
of **none** of those tips, and the unranged read returning that same commit in all
seven.

One instrument note, measured. `gh pr view <N> --json commits -q
'.commits[] | .messageHeadline'` is **lossy**: across the nine PRs' 22 commits,
17 headlines ended in `…` and every one of those measured exactly 70 characters
(69 plus the ellipsis), while the longest intact one is 72 — so the cut lands
somewhere between, and the projection counts commits faithfully while quoting
them wrongly. Read the commit object above for the text itself; the branch
commits survive the branch deletion inside the PR record. And the composition is
a fact about the **message** only: whether what landed is what was reviewed is a
separate measurement — the patch-id comparison in rule 32 of
`docs/development/review-checklist.md`, and the tree/origin check in rule 49.

## Habits this buys

- **Never read a branch commit without a range.** `git log --no-merges -1
  <branch>` can hand you another PR's commit whenever the tip is a merge **and
  something it merged in is newer than the branch's own commit** — it means
  "newest non-merge commit reachable", ordered by date, and main is reachable. A
  merge tip is necessary for that and not sufficient: #1964 survives the same
  shape by 40 seconds that #1623 loses by 30 minutes, and of the 22 merge-tipped
  rows in one window, 21 returned a different commit. A wrong commit reads exactly
  like a right one — range from `git merge-base`.
- **Before a press, count the non-merge commits.** One: the **commit message is
  the landed message** — subject and body — so fix it in the commit and do not
  rely on the PR title. Two or more: the **title is the subject** and the commit
  messages are the body, so a subject fix is a title edit and a text fix is a
  commit amend. A commit-message fix moves the head and so costs a re-stamp
  (rule 44); a title edit does not.
- **A credit line must be in the commit message.** It lands in the body in every
  shape, and in the subject too for a one-commit PR; a PR-body line lands
  nowhere.
- **After a merge:** `git log -1 --format=%B <merge>` answers "what does main
  say"; the PR page answers "what did the branch say last".
- **A landed-and-wrong message cannot be unlanded.** A follow-up commit puts a
  correction next to it, which is a different artifact from a fix — the remedy
  that works is the one taken before the press.
- **Never cite a PR title as a landing claim.** It is the subject for 2+ commits
  and irrelevant for one commit; the merge commit is the only reader that knows.
- **A landing that matches neither candidate is an override**, not a rule you
  have not found yet: check the non-merge count and the title's rename history
  before concluding anything about the mechanism.
