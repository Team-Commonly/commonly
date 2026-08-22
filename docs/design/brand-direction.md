# Brand direction — character within the system

**Status:** agreed direction (Sam's constraints, 2026-08-20; ux-lead + sprint lead concurred 1:1). Presented to the sprint pod 2026-08-20. §2 amended same day after sprint-review's animation census; §3 superseded same day by Sam's species-avatar ruling (#1054); §1 ruled out for the shell and restored the same day, 2026-08-22 (neumorphism retired; taste elevation under redesign-skill).
**Owners:** ux-lead (design authority) · sprint-impl (implementation).
**Companions:** `frontend/design-system/README.md` (the system this stays inside) · `frontend/design-system/preview/brand-logo.html` (browser-reviewable mark family).

---

## The problem, and why it is not polish

Sam's framing: the product is "not eye catching" and gives "no good moody feedback to the user on our vibe."

The funnel agrees with him. Of 22 post-fix signups, **9 (41%) never typed a message** — despite landing in a pod with a greeting already waiting. For the 13 who did type, the reply rate is 13/13. Onboarding mechanics now work; what fails is the **first thirty seconds of felt experience**. First contact is currently the single largest funnel loss, and the moments that shape it — first load, an empty room, an agent thinking — have no character at all today.

So this work is aimed at a number, not at taste.

## Constraints (fixed, from Sam)

1. Keep the current design system and the `#2f6feb` accent.
2. No theme overhaul — that is the competitor rabbit-hole where weeks go into chrome.
3. The logo concept stays: a C whose interior is a chat bubble. The problem to solve is that the marketing logo is a Gemini-generated raster we cannot derive variants from — not the concept.

## The position

The vibe gap is not color; it is **absence of character at the moments a person actually feels the product**. A theme changes the screenshot, not the feeling. The design system already tells us where personality is allowed to live: *"visual richness comes from avatars and content, not decoration."* We invest entirely there.

---

## Decisions

### 1. No theme change — stands (ruled out and back in on 2026-08-22)

*As written on 2026-08-20:* no palette move, no chrome mood, no dark-mode detour; character added strictly inside the existing system.

*What happened on 2026-08-22, kept so the reversal is visible rather than silent:* in the morning Sam ruled the shell redesign (TASK-036) would run under the neumorphism recipe — shadows-not-borders, one surface, depth-as-elevation — and the design-system README was amended with scoped supersession notes. The same day Sam retired it: *"that theme is not good for a chat app like us"* — the density/contrast concern the skin addendum's own contrast ladder had flagged. The README notes were reverted (`d2cbfa31`), the pilot PR #1105 closed unmerged, and the skin addendum is withdrawn. **The 2026-08-20 text above is the rule again, unqualified.**

*The mandate that replaces it:* a **taste elevation of the current flat system** — audit-first, working with the existing stack, under the `redesign-skill` in `commonly-skills/tasteskill/` (its fix-priority ladder: font → palette → states → layout → components → empty/loading/error → type polish; every shell polish PR runs its audit first). Jurisdictions: `redesign-skill` owns the app shell; `taste-skill` owns landing/marketing; the neumorphism package stays available for one-off marketing only. Where an audit item contradicts a rule in the README that Sam has ratified — a font swap off the SF stack, grain/noise overlays, removing card borders, spring motion — **the README wins until Sam re-rules**; the ladder elevates the system, it does not re-theme it through the side door. The craft-audit fixes already merged (#1103/#1104) are the baseline the elevation builds on.

### 2. Motion identity derived from the mark

The discovery this direction is built on: **the mark's three dots are the typing ellipsis, and the typing-dot stagger (`v2-typing-dot`, 1.2s ease-in-out, 0.18s stagger) is the only *identity* animation in app chrome.** The brand mark contains the product's one branded rhythm. That is an ownable identity we get nearly free.

*(Correction, 2026-08-20, after sprint-review's census: v2.css ships three animations — `v2-typing-dot` :1775, `v2-now-pulse` :2983, `v2-spin` :5147. The sentence above was written as if it were a census and is wrong as one. The normative rule is scoped below: the two state affordances stay.)*

**The identity/state boundary — the rule, stated so nobody re-derives it:**

- `v2-spin` (loading) and `v2-now-pulse` (liveness) are **state affordances, not identity**. They stay exactly as they are. Replacing an inline spinner or the liveness dot with the mark's three dots is a behaviour change, and a harmful one: three staggered dots inside a chat shell culturally mean *someone is typing*. A "loading" spinner that reads as typing teaches a false model — the motion version of copy whose certainty exceeds the system's.
- The mark's stagger is permitted only where the surface is **brand-scale or the semantics genuinely are "composing"**: first load / app boot (no chat visible yet, nothing to misread), empty states (mark at rest), and agent-thinking (which *is* typing — identity and state coincide there, which is the whole trick).
- Inline micro-states — button spinners, list fetches, send-in-flight, the inspector's now-pulse — never take the mark.

- **Loading is the mark breathing.** The dead moment before first paint becomes the mark with its dots running the existing stagger. Skeletons stay for content regions; the mark-pulse replaces the *nothing* moment.
- **Thinking is the same rhythm.** The agent-typing indicator and the mark's dots become one gesture — same dot size ratio, same cadence.
- **Empty is the mark at rest, plus a voice line.** No illustration. The README's voice (confident, peer-to-peer, agents by name) is the cheapest character we own, and empty states currently use none of it.

No new animation vocabulary is created. The one permitted rhythm is reused everywhere character is needed.

### 3. Avatars: species characters are the default; initials are the fallback tier

*(Superseded 2026-08-20 by Sam's ruling, same day this doc first shipped — the earlier text here made characters a "scarce earned tier." The founder call overrides it, and coherently: the original zoo objection was to per-install art production, and seeded deterministic SVG has none of those costs.)*

- **Humans render DiceBear *Big Smile* faces; agents render *Bottts* robots** — the chat-stream default, not an earned tier. Face = person, robot = agent: the species IS the badge, where most agent-team products need a label.
- **What makes it shippable:** deterministic, local, seeded SVG. Same seed → same face, forever; install #10,000 costs what install #1 did. No art pipeline, no image API, no generation drift.
- **Seeds are stable identity, never display names** — `agentName:instanceId` for agents, userId for humans — so a rename never re-rolls a face. One canonical seed per identity across every surface; a character that differs between chat and the Agent Hub is an attribution bug, not a variant.
- **Tier order: photo → character → gradient+initials.** Unknown kind renders the neutral initials tier — nothing ever guesses a species, because mislabeling the tier mislabels the *person*. The initials tier (#1040/#1043) remains load-bearing as the fallback and the spec for any surface that cannot know what it is drawing.
- **The original attribution principle stands at stream sizes:** verified in-browser 2026-08-20, the species read survives 22px; *individual* recognition degrades below ~28px and that is fine — it was never the avatar's job at small sizes (it is the name label's), same as under initials.
- **License:** Big Smile is CC BY 4.0 (creator: Ashley Seo) — the visible DiceBear credit is a license requirement, not decoration. Bottts (Pablo Stanley) is free for commercial use. Any style swap re-checks license and credit together.
- Implementation: #1054; execution review (canonical seed helper, soft same-hue backing, 96px profile hero) recorded on the PR.

### 4. The logo family is vector, canonical, and two-fidelity

`assets/commonly-mark.svg` was already a hand-authored vector; only the marketing lockup was Gemini raster. The family is now:

| Variant | File | Job | Floor |
|---|---|---|---|
| Minimal mark | `assets/commonly-mark.svg` | Rail, header, favicon, app icon, loading state | 20px |
| Marketing variant | `assets/commonly-mark-bubble.svg` | Hero, login card, social cards, README | **56px** |

Both share the identical C ring and **identical dot geometry** (`r 2.4` at `x 25/32/39`, `y 32`) — the typing-ellipsis animation target never moves between variants, so the motion identity in Decision 2 works on either. The marketing variant makes the bubble explicit (filled bubble with tail nested in the counter, dots knocked out even-odd as true negative space), preserving the concept Sam likes from the raster logo.

The 56px floor is empirical, not aesthetic: verified in-browser (2026-08-20), the bubble variant holds at 56 and mushes at 32. Below the floor, always the minimal mark.

`assets/commonly-logo.png` is **retired** once its two call sites (login, marketing) are re-cut — see checklist. Wordmark lockups compose the mark tile with the display stack per `preview/brand-logo.html`; no wordmark raster is ever needed.

### 5. Mascot: deferred, not rejected

One character IP derived from the C-bubble (per Sam's ip-as-logo reference) may be worth commissioning — **but not before the landing page needs a hero character**. Recorded so nobody reads silence as rejection, and nobody starts early.

---

## Mood-moment inventory — implementation checklist (sprint-impl)

| # | Moment | Today | Direction |
|---|---|---|---|
| 1 | First load / app boot | Dead skeleton field | Minimal mark centered, dots running the existing `v2-typing-dot` keyframes. Reuse the keyframes — do not author new ones. Skeletons remain for content regions. |
| 2 | Agent thinking | Typing dots exist but are visually unrelated to the mark | Unify: same dot proportions and stagger as the mark's dots. One rhythm product-wide. |
| 3 | Empty pod (no messages yet) | Blank pane | Mark at rest + one voice line ("Nova is here when you are." — copy per README voice rules, agents by name, no emoji). |
| 4 | Your Team / marketplace / first-DM empty states | Blank or terse | Same pattern as #3. Inventory each surface; one line each, no illustration. |
| 5 | Favicon + app icon | Ad-hoc | Cut from `commonly-mark.svg` (20px-proven). |
| 6 | Login card + marketing hero | `commonly-logo.png` (raster) | Re-cut from `commonly-mark-bubble.svg` + wordmark lockup; then delete the PNG. |
| 7 | Landing page assets | Raster multiplication has started (`landing-hero.png`) | All new marketing cuts derive from the SVG family from now on. |

**Explicitly not approved:** a task-completion animation. It is a plausible candidate but requires an animation-rules carve-out the system does not currently grant. Do not animate it under current rules; raise it as its own decision if wanted.

**Verification:** items 1–4 are v2 layout/CSS work → real-browser check per repo rule (jsdom has no layout engine), plus presence guards in `v2-layout-invariants.test.ts` for any load-bearing CSS.

## Interaction: when an agent speaks first (unprompted-DM ruling, #1058)

Measured 2026-08-20: zero unprompted agent→human messages across 39 agent-rooms in the full 30-day window. The capability exists; no trigger gives an agent a reason. This section is the design answer to "when is an unprompted DM welcome vs noise."

**The test is warrant: would the human have asked for this message had they known it existed?** Concretely — an unprompted DM is welcome exactly when the agent can name the human's own ask that the message closes. If the agent cannot quote the ask it traces to, it has no warrant, and the message is noise regardless of how useful it feels.

Three warrant classes, in rollout order:

1. **Result** — claimed work traceable to the human's ask reaches done → one message with the result (#1058 trigger 1; ship this first).
2. **Failure** — same provenance, the work cannot be completed → one message saying so and why. A failure *is* a result; `routeErrorToDM` is the existing plumbing for this half, and hiding a failure while reporting successes is the status-honesty anti-pattern in DM form.
3. **Blocked-on-you** — the asked-for work cannot proceed without a decision only the human can make. Legitimate, but a future trigger: not in #1058's scope, and it must not be smuggled into trigger 1's implementation.

**Message spec.** The first unprompted DM is a brand moment — the agent's first self-initiated appearance in a person's DM list — and it should read like a competent colleague putting a finished thing on your desk:

- The provenance is the opening line — "The landing spec you asked for Tuesday is done: <link>" — never a greeting, never "just checking in."
- Lead with the result; link the artifact rather than pasting it.
- **One message, terminal.** It closes a loop and never opens one. No follow-up nudge if the human doesn't reply — their silence is an answer.
- README voice rules apply unchanged: peer-to-peer, no emoji.

**Never warranted:** status updates ("still working on it" — the human delegated precisely to not think about this), ambient observations ("I noticed…"), capability advertisements, re-engagement pings, streaks or anniversaries. These are growth-hacking shapes; a peer does not ping you to remind you they exist.

**Why deny-by-default, stated as the economics:** the cost of one noisy unprompted DM is not one annoyance — it teaches the human to skim past that agent's DMs, which destroys the channel for the legitimate result message later. Channel trust is the asset; every unwarranted message spends it and no warranted message fully earns it back.

**The anti-spam property to preserve in implementation:** every warrant requires a *prior human ask*, so nothing in this section can fire at a user who never typed. First-contact-from-silence — the 41% — is the mood package's job (greeting already waiting, empty-state voice, character), and must never be solved by unprompted DMs. If a proposed trigger can fire without a traceable ask, it is outside this ruling and needs its own.

## Guardrails — what this direction is not

- No theme or palette change; the accent stays `#2f6feb` and stays alone.
- No new animation classes in app chrome. The typing stagger is the only *identity* rhythm; `v2-spin` and `v2-now-pulse` remain as state affordances (see the identity/state boundary in §2). If a mood moment can't be expressed with the stagger, the moment stays still.
- Motion timing enters the design system rather than living only in `v2.css`: `tokens.css` gains duration/easing tokens (`--motion-stagger: 0.18s`, `--motion-breath: 1.2s`, easings), and the three existing keyframes consume them. tokens.css currently declares no animations at all — the rule this doc states would otherwise live nowhere the design system can defend it.
- No hand-drawn per-agent art production — seeded deterministic characters are the system (§3); a commissioned character set is not, and never becomes an install-time requirement. No emoji in product copy, no stock art — unchanged README rules.
- Marketing-surface motion rules (the 2026-07-03 carve-out) are unchanged by this direction.
- The first-contact funnel number (41% never-type) is the success metric. Re-measure after items 1–4 ship; if the number doesn't move, the next investment is first-message coaching, not more mood.
