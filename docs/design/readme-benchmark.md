# README benchmark: seven open-source front doors

**Status:** brief for TASK-422, 2026-10-24. Gates: ux-lead for visuals and brand.
**Purpose:** the next README pass starts here, not from scratch. Part 1 records what seven well-regarded projects actually put in their README. Part 2 lists patterns across them. Part 3 is the rules our README follows. Part 4 checks today's README against those rules.

Every row cites the README at a pinned commit, so a later reader can tell whether a project has changed since. Counts come from the raw file at that commit, not from the rendered page.

---

## 1. The seven READMEs

| Project | Source (pinned) | Lines / words (`wc`) |
|---|---|---|
| Supabase | [supabase/supabase@7e866ef](https://github.com/supabase/supabase/blob/7e866ef83e89e35cdda45a6c98abd069d5fa1b2f/README.md) | 288 / 1,130 |
| n8n | [n8n-io/n8n@3c7a553](https://github.com/n8n-io/n8n/blob/3c7a553dc009a8d06bfd0b55e013c6df03906965/README.md) | 73 / 503 |
| Cal.com → Cal.diy | [calcom/cal.diy@0f19cc4](https://github.com/calcom/cal.diy/blob/0f19cc46ef6b6426ee398c670575b3c96be7af9e/README.md) | 837 / 4,680 |
| Excalidraw | [excalidraw/excalidraw@b7de45e](https://github.com/excalidraw/excalidraw/blob/b7de45e88111f5680ae4bb3c3f3541c7d3b279fe/README.md) | 124 / 495 |
| Zed | [zed-industries/zed@79fe6a6](https://github.com/zed-industries/zed/blob/79fe6a645f68f8c9230578f154bf99852d9f716f/README.md) | 48 / 298 |
| Ollama | [ollama/ollama@675150d](https://github.com/ollama/ollama/blob/675150d6ad2747df1e218ef59de9194bc4a7e538/README.md) | 357 / 1,620 |
| LangGraph | [langchain-ai/langgraph@4c52e12](https://github.com/langchain-ai/langgraph/blob/4c52e129eb1ab69a3da58b799f67929f77d81149/README.md) | 82 / 601 |
| *Commonly today* | [Team-Commonly/commonly@7d2d28f](https://github.com/Team-Commonly/commonly/blob/7d2d28f5/README.md) | 109 / 508 |

**About the Cal.com row.** `github.com/calcom/cal.com` now redirects to `calcom/cal.diy`. Its README describes Cal.diy, an MIT community fork with the enterprise code removed. It opens with two GitHub alert boxes ("Use at your own risk…", "use Cal.com, not Cal.diy") before the logo. The README that made Cal.com a reference for open-source front doors no longer lives at that URL. The row records what is there now. Treat it as a long-form self-hosting README, not as Cal.com's marketing front door.

### What each one does

| | Hero / banner | One-line pitch | Product image | Quickstart (≤5 commands?) | Badges | Community links | How-it-works diagram | Sponsors / contributing |
|---|---|---|---|---|---|---|---|---|
| **Supabase** | Wordmark image, separate light and dark files (`#gh-light-mode-only` / `#gh-dark-mode-only`) | "Supabase is the Postgres development platform. We're building the features of Firebase using enterprise-grade open source tools." | One dashboard screenshot, plus a small "watch releases" GIF | None in the README. Hosted signup needs no install, and docs are linked | None at the top. A late "Badges" section offers *Made with Supabase* badges for users' own projects | A section that pairs each channel with **what it is best for**: Forum, Issues, Email, Discord | **Yes**: architecture SVG, then one line per component (Postgres, Realtime, PostgREST, GoTrue, Storage…) | Contributing via DEVELOPERS.md. A client-library table. Links to 40+ README translations |
| **n8n** | Full-width banner JPG | "n8n – The Platform for AI Agents and Workflow Automation", then a two-line paragraph naming integrations, self-host and cloud | One canvas screenshot, directly under the pitch | **Yes, 1**: `curl -fsSL https://get.n8n.io \| sh`, or 2 Docker commands. Then "Access the editor at http://localhost:5678" | None | Forum, under Resources and Support | No | Short Contributing, "Join the Team", and a charming "What does n8n mean?" |
| **Cal.diy** | Two warning boxes, then a centered logo, name and subtitle, with GitHub, Issues and Contributing links | "The community-driven, open-source scheduling platform." | One booking-screen screenshot | **No**: prerequisites plus a numbered clone / cd / yarn / .env / db setup sequence, well past 5 | 6 (license, stars, commit activity, Docker pulls, help wanted, Contributor Covenant) | Issues only | No | Contributing, good first issues, contributor grid, translations, acknowledgements. Eleven "Obtaining … credentials" subsections sit inline (13 headings under Integrations) |
| **Excalidraw** | Full-width cover image in a `<picture>` element with a dark-mode source. A link row under it: Editor, Blog, Docs, Excalidraw+ | "An open source virtual hand-drawn style whiteboard. Collaborative and end-to-end encrypted." (as an H2) | One product showcase image with a caption | 1 command, `npm install react react-dom @excalidraw/excalidraw`, but it installs the **embed package** for your own app, as the README itself notes. The product is the hosted excalidraw.com | 6 (license, npm downloads, PRs welcome, Discord, DeepWiki, X) | Discord badge, plus Discord in Contributing | No | Contributing, integrations, a "Who's integrating" row of text links, Open Collective sponsors, in-kind sponsors |
| **Zed** | None: a plain `# Zed` | "a high-performance, multiplayer code editor from the creators of Atom and Tree-sitter" | None | Download link plus package managers, no commands | 2 (version, CI) | None | No | Contributing, hiring, licensing notes for contributors, GitHub Sponsors |
| **Ollama** | Centered logo, 200 px | "Start building with open models. Access the latest releases locally or in the cloud with complete privacy." | None | **Yes, 2**: one install line per OS, then `ollama`. Per-task examples follow (`ollama launch claude`, `ollama run gemma4`) | None | Discord, X and Reddit, inside the Download section | No | REST API and SDK examples, then a long Community Integrations directory (about 200 of the 357 lines) |
| **LangGraph** | Logo SVG, light and dark via `<picture>`, 50% width | "Low-level orchestration framework for building stateful agents." (H3), then a sentence naming customers | None | **Yes, 1**: `pip install -U langgraph` | 4 (license, downloads, version, X) | Forum, inside Documentation | No | Contributing guide and Code of Conduct, plus acknowledgements (Pregel, Beam, NetworkX) |
| *Commonly today* | Centered 72 px raster logo, H1, two-line pitch, two CTA links | "Bring your workflow and your agents. Your team works with them in one pod." | **Four** 880 px screenshots. "Your agents, or ours" has none: this PR dropped its frame, which showed a real machine name | Yes, 3 (`git clone`, `cd`, `./install.sh`), plus a 4-line MCP command | None | Discord, Issues, Security, License (footer line only; the hero Discord badge was dropped by #2477) | No | Contributing line with a good-first-issue link |

### Section order

| Project | Order after the hero |
|---|---|
| Supabase | Feature checklist → screenshot → Documentation → Community & Support → How it works (architecture, client libraries) → Badges → Translations |
| n8n | Screenshot → Key Capabilities → Quick Start → Resources → Support → License → Contributing → Join the Team → What does n8n mean? |
| Cal.diy | About (+ differences, Built With) → Getting Started → Development → Deployment (Docker, five hosts) → License → CSP → Integrations (11 credential guides) → Contributing → Acknowledgements |
| Excalidraw | Showcase → Features → Excalidraw.com → Quick start → Contributing → Integrations → Who's integrating → Sponsors |
| Zed | Installation → Developing → Contributing → Licensing → Sponsorship |
| Ollama | Download (per OS, libraries, community) → Get started → REST API → Supported backends → Documentation → Community Integrations |
| LangGraph | Install → Why use LangGraph? → Ecosystem → Documentation → Additional resources → Acknowledgements |
| *Commonly today* | What is Commonly? → Your agents, or ours → A person decides → One roster → Your tools → Bring your own → Quick Start → Docs → Contributing |

---

## 2. Patterns across the seven

1. **The pitch names the category in plain words.** "Postgres development platform." "Workflow automation." "Scheduling platform." "Whiteboard." "Code editor." "Orchestration framework for … agents." Six of seven say what the thing *is* in the first line. Only Ollama leads with an outcome, and its name and logo already carry the category. A slogan that a reader must decode before knowing the category appears in none of them.
2. **One product image, right under the pitch, or none.** Supabase, n8n, Cal.diy and Excalidraw each use exactly one primary product image, placed high. Zed, Ollama and LangGraph use none and lead with the install line instead. None of the seven uses a screenshot per section.
3. **The install line is one command.** Of the five that show commands, three reach a working product in one or two (n8n, Ollama, LangGraph). Excalidraw's one command installs its embed package for your own app, not the product. The exception is Cal.diy, and its README is the longest, 2.3× the next (Ollama). The best ones then say what to open (n8n: "Access the editor at http://localhost:5678").
4. **Hosted first when there is a hosted product.** Supabase says you can "sign up and start using Supabase without installing anything" before mentioning self-hosting. n8n links the cloud in its first paragraph. Ollama says "locally or in the cloud."
5. **Capabilities are short, bold-led bullets.** n8n has six "Key Capabilities", LangGraph five "Why use" bullets, and Supabase a checklist. Linking each to its docs is LangGraph's pattern: it links every bullet, Supabase links 4 of 7, and n8n links none. Where they link, the README states the claim and the docs carry the proof.
6. **Badges are few or absent.** Three of seven have none. The rest use 2 to 6, mostly signal badges (license, version, downloads, CI, chat) plus some social ones: GitHub stars and commit activity (Cal.diy), PRs welcome and DeepWiki (Excalidraw), X follow (Excalidraw, LangGraph).
7. **Dark mode is handled on purpose.** Supabase, Excalidraw and LangGraph ship separate light and dark hero art (`<picture>` with `prefers-color-scheme`, or the GitHub mode suffixes). A logo with a white box behind it on GitHub's dark theme is the most visible "unprofessional" tell.
8. **Only one has an architecture diagram, and it earns it.** Supabase is a composition of named open-source services, so the diagram *is* the pitch ("we use enterprise-grade open source tools"). The others don't need one.
9. **Community links say what each channel is for.** Supabase's "Best for:" line per channel is the clearest. It routes bugs to Issues and chat to Discord.
10. **Depth lives in docs.** The two longest READMEs (Cal.diy at 837 lines, Ollama at 357) are long because of inline reference material: credential walkthroughs and an integrations directory. The other five stay between 48 and 288 lines.
11. **Personality is allowed, once and at the bottom.** n8n's "What does n8n mean?" and LangGraph's acknowledgements are human. They come after everything a newcomer needs.

---

## 3. Rules our README follows

Each rule cites the pattern it comes from. A later pass that breaks a rule should say why in its PR.

1. **Hero:** one centered block with the mark and wordmark from the brand pass (TASK-423), as SVG, with light and dark sources via `<picture>`. No raster logo, and no white box on dark. (Patterns 2, 7)
2. **Pitch:** one line, under 15 words, that names the category in words a stranger already knows. Then at most one sentence of who it is for. No term the README hasn't yet defined ("pod" needs its definition in the same breath, or it waits). (Pattern 1)
3. **Two calls to action under the pitch:** the hosted product first (commonly.me, nothing to install), then self-host. (Pattern 4)
4. **One product image above the fold**, captioned, from the live product, with full alt text. **At most two product images in the whole README**; the rest go to docs. (Pattern 2)
5. **Capabilities:** 4 to 6 bold-led bullets, each linking to its docs page. **Every bullet maps to a row of the walked truth table** (§3.1). Nothing in the README is unwalked or unshipped. (Pattern 5, after LangGraph)
6. **Quickstart:** at most five commands from a fresh machine to a working state, each block copy-pasteable as is, ending with what to open. One block for joining with your own agent and one for self-hosting, nothing more. (Pattern 3)
7. **Badges:** four at most, all signal. The **Discord badge is required** (`discord.gg/NsS3fzsJDw`). The others are chosen from license, CI and the npm version of `@commonlyai/cli`. They sit under the CTAs, never above the logo. (Pattern 6)
8. **How it works:** include a diagram only if it is true and it *is* the pitch. For Commonly that would be "your agent runs where it runs, and joins the pod over CAP". Hold it until ux-lead draws it from the Signal tokens. Drop it rather than ship a generic box chart. (Pattern 8)
9. **Community: Discord is REQUIRED in the hero.** The Discord badge plus a "Join the community" link to `https://discord.gg/NsS3fzsJDw` must sit in the first 40 lines. TASK-430's `scripts/verify-readme-invariants.js` checks this, along with docs, license and quickstart links. Lower down, one community section lists each channel with what it is best for: Discord for chat, Issues for bugs, Security for reports. (Pattern 9)
10. **Length:** 80 to 150 lines. Reference material goes to `docs/` or docs.commonly.me and gets a link. (Pattern 10)
11. **Order:** hero → pitch + CTAs → image → capabilities → quickstart → how it works (optional) → docs → community → contributing + license → one human line (optional). (Patterns 3, 5, 11)
12. **Voice:** plain, present tense, no superlatives, no em-dash chains, US English. It passes the same copy gate as product UI.

### 3.1 What can be claimed (the walked truth table)

Every row cites its source: `backend/config/native-agents/scout.ts` pinned at `bf0bd593` (the facts Scout is held to, each with the walk it came from), or the page code that renders the claim. A row with no citation is not a claim. Re-read the sources before each README pass. If the README and Scout disagree, one of them is wrong; find out which before writing.

| Claim | Walked status |
|---|---|
| Your own Claude Code joins as a teammate that answers @mentions | **Mac, and Linux or WSL in invite-only pods** (TASK-027). Not native Windows (no sandbox). Earlier: Mac only (Linux run 38982219348). [scout.ts:140-148](https://github.com/Team-Commonly/commonly/blob/bf0bd593/backend/config/native-agents/scout.ts#L140-L148) |
| Your own Codex joins as a teammate | Mac and Linux, WSL included. Not native Windows. [scout.ts:144-147](https://github.com/Team-Commonly/commonly/blob/bf0bd593/backend/config/native-agents/scout.ts#L144-L147) |
| OpenCode (any provider, e.g. DeepSeek) | Via `docs/cli/opencode.md`, walked on a Mac only. [scout.ts:114-123](https://github.com/Team-Commonly/commonly/blob/bf0bd593/backend/config/native-agents/scout.ts#L114-L123) |
| DeepSeek Harness (dsh) | Attached as your own agent in a **private pod**, via its attach guide. Walked on macOS; other OSs unverified. [scout.ts:145-146](https://github.com/Team-Commonly/commonly/blob/bf0bd593/backend/config/native-agents/scout.ts#L145-L146), [scout.ts:165-171](https://github.com/Team-Commonly/commonly/blob/bf0bd593/backend/config/native-agents/scout.ts#L165-L171) |
| Hermes (CLI adapter) | Connects from the command line (`commonly agent attach hermes`). Walked 2026-10-22: Hermes 0.22.2 on macOS, a non-admin account in an invite-only pod, a mention answered in 56 s. The walk ran on our LiteLLM provider, so **claim nothing about OpenRouter or any other provider.** Word it only as "Hermes (CLI adapter)". [scout.ts:124-135](https://github.com/Team-Commonly/commonly/blob/bf0bd593/backend/config/native-agents/scout.ts#L124-L135), added by #2569 (TASK-429) |
| Claude and GPT (via Codex) in one pod, each answering @mentions | Yes. [scout.ts:150-163](https://github.com/Team-Commonly/commonly/blob/bf0bd593/backend/config/native-agents/scout.ts#L150-L163) |
| Gemini | **Cannot join yet.** Do not claim it. [scout.ts:154-155](https://github.com/Team-Commonly/commonly/blob/bf0bd593/backend/config/native-agents/scout.ts#L154-L155), [scout.ts:162-163](https://github.com/Team-Commonly/commonly/blob/bf0bd593/backend/config/native-agents/scout.ts#L162-L163) |
| MCP (`claude mcp add commonly …`) | Gives Commonly tools *inside your own sessions*. **Does not answer @mentions.** Only `commonly agent run` (the listener) does. [scout.ts:108-113](https://github.com/Team-Commonly/commonly/blob/bf0bd593/backend/config/native-agents/scout.ts#L108-L113) |
| "Run it here" hosted agent | Yes. Commonly runs it on a model Commonly picks. [scout.ts:161-162](https://github.com/Team-Commonly/commonly/blob/bf0bd593/backend/config/native-agents/scout.ts#L161-L162); the button is `SCOUT_HOSTED_START` ([scout.ts:41](https://github.com/Team-Commonly/commonly/blob/bf0bd593/backend/config/native-agents/scout.ts#L41)) |
| Add a computer once, then add agents from the page | `npm i -g @commonlyai/cli@latest && commonly login && commonly daemon register && commonly daemon install`. [scout.ts:136-139](https://github.com/Team-Commonly/commonly/blob/bf0bd593/backend/config/native-agents/scout.ts#L136-L139); the page renders the same line as `DAEMON_SETUP_COMMAND` ([V2AgentBYO.tsx:67](https://github.com/Team-Commonly/commonly/blob/bf0bd593/frontend/src/v2/components/V2AgentBYO.tsx#L67)) |

---

## 4. Today's README against these rules

| Rule | Today | Gap |
|---|---|---|
| 1 Hero | 72 px raster PNG (`frontend/src/assets/commonly-logo.png`), no dark source | Needs the SVG mark and wordmark from TASK-423 |
| 2 Pitch | "Bring your workflow and your agents. Your team works with them in one pod." | A slogan. It doesn't name the category, and it uses "pod" before defining it |
| 4 Images | Four 880 px screenshots | Cut to one, or two at most |
| 5 Claims | "Claude Code, Codex, OpenCode CLI, Hermes or DeepSeek Harness from your machine" | Platform limits are missing (Claude Code is Mac-only as a teammate). **Hermes:** keep it, worded only as "Hermes (CLI adapter)" (§3.1). Scout now lists it, via #2569 (TASK-429). Today's README doesn't qualify it as the CLI adapter |
| 5/6 MCP | "Bring your own" leads with the MCP command and "Then ask it for real work" | Accurate for your own session, but it reads as if this makes the agent a teammate. Per the truth table, MCP alone does not answer @mentions. The teammate path is `commonly agent run` |
| 9 Community | Footer link only (`discord.gg/NsS3fzsJDw`, last line) | The Discord exists. It had a README badge from #694/#695 (2026-07-19) until #2477 dropped it. **Restored in the hero by this PR.** The rewrite keeps it there (rule 9), and TASK-430 guards it |
| 7 Badges | None | Fine. Add up to four signal badges |
| 10 Length | 109 lines | Within range |

---

## 5. Next

- **Draft (due Sun 18:00):** README to the rules above, in a PR against this doc, using ux-lead's hero and social card once TASK-423 lands. ux-lead gates visuals.
- **Docs pages** get the same pass afterwards (TASK-422 notes). `docs/audits/TASK-003-docs-site-audit.md` already lists unwalked pages.
