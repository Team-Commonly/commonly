# Brand direction — character within the system

**Status:** agreed direction (Sam's constraints, 2026-08-20; ux-lead + sprint lead concurred 1:1). Presented to the sprint pod 2026-08-20.
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

### 1. No theme change

No palette move, no chrome mood, no dark-mode detour. Character is added strictly inside the existing system. Any proposal that requires new chrome surfaces, new gradients in chrome, or new animation classes is out of scope by default.

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

### 3. Avatars: initials are the system; illustration is a scarce, earned tier

- The per-identity system is **seeded gradient + initials** (#1040, with the parenthetical-initials fix from #1043). Attribution is the avatar's first job, and at 24px in a dense stream, tint + initials beats any illustration at answering "who spoke."
- **Illustrated character does not scale as a default.** Every marketplace/BYO install would need art; auto-assignment collides (two agents wearing the same fox is worse than two sharing a teal); generated art recreates the exact non-derivability problem this direction exists to fix. Twenty-eight characters is a zoo unless one hand draws them all.
- **The earned tier:** first-party named agents may later receive hand-made illustrated identity, surfaced at large sizes only (Agent Hub cards, hire flow, marketplace detail) — never as the chat-stream avatar. This ruling is now encoded in the design-system README (Imagery vibe section, via #1040).

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

## Guardrails — what this direction is not

- No theme or palette change; the accent stays `#2f6feb` and stays alone.
- No new animation classes in app chrome. The typing stagger is the only *identity* rhythm; `v2-spin` and `v2-now-pulse` remain as state affordances (see the identity/state boundary in §2). If a mood moment can't be expressed with the stagger, the moment stays still.
- Motion timing enters the design system rather than living only in `v2.css`: `tokens.css` gains duration/easing tokens (`--motion-stagger: 0.18s`, `--motion-breath: 1.2s`, easings), and the three existing keyframes consume them. tokens.css currently declares no animations at all — the rule this doc states would otherwise live nowhere the design system can defend it.
- No per-agent illustration, no emoji in product copy, no stock art — unchanged README rules.
- Marketing-surface motion rules (the 2026-07-03 carve-out) are unchanged by this direction.
- The first-contact funnel number (41% never-type) is the success metric. Re-measure after items 1–4 ship; if the number doesn't move, the next investment is first-message coaching, not more mood.
