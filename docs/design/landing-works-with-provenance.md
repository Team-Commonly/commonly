# Landing "Works with" section: provenance

The section lists what has been walked end to end, and every tile shows a mark. This page records where each mark came from and what its owner's rule says. Files read 2026-11-05.

- Code: `WORKS_WITH_AGENTS`, `WORKS_WITH_APPS` and `WORKS_WITH_LOGOS` in `frontend/src/v2/landing/V2LandingPage.tsx`; files in `frontend/public/logos/works-with/`; styling in `.v2-landing__works*`. `frontend/src/v2/landing/__tests__/worksWithLogos.test.ts` holds them together, and rejects a file with script, `foreignObject`, event handlers or external references.
- Each logo is one line in `WORKS_WITH_LOGOS`, so any one can be removed without touching the others. Remove the file and its row in the same change.
- An addition needs a walk first. Downloaded SVGs are untrusted: each goes in its own new directory and through that check before it is committed.

## Why logos show where a rule asks for permission

The decision on 2026-11-05 was to show every tile's logo, as other tools do. Where the table says permission is required, we have not obtained it. The rule stays here so the decision stays visible. The section says these work with Commonly. It does not say any vendor built, endorses or partners with Commonly.

## How a mark is drawn

No mark is redrawn and no shape is changed. A vendor pair shows the file for each ground. A one-colour file is drawn in ink by CSS (`--mono`), and the two-tone Telegram file is drawn in ink and ground (`--tone`). Both change the colour on screen, not the file or its shape. Where a file is a lockup, we keep the vendor's own mark paths byte for byte and drop the wordmark; where it carries a wide margin, we only tighten the `viewBox`.

## Agents

| Entry | File | Source, date | Licence | Vendor's rule | Walk |
|---|---|---|---|---|---|
| Claude Code | `claude-code-mark.svg`, drawn mono | [Claude Code docs logo](https://mintcdn.com/claude-code/c5r9_6tjPMzFdDDT/logo/light.svg), 2026-11-05. Mark path kept byte for byte, wordmark dropped, `viewBox` set | Proprietary, no licence | **Requires written permission.** [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance): plain text is allowed, any other use of the names or logos needs written permission; [trademark guidelines](https://www.anthropic.com/legal/trademark-guidelines) | `docs/agents/byo-support-matrix.md`: Mac and Windows 11-04, Linux 11-05 |
| Codex | `openai-blossom-black.svg`, `openai-blossom-white.svg` | [OpenAI logo bundle](https://cdn.openai.com/brand/openai-logos.zip), 2026-11-05. `viewBox` tightened from 716 to 356, paths untouched. **This is OpenAI's Blossom: no Codex-specific mark was found** | Proprietary, no licence | **Requires permission.** [OpenAI brand guidelines](https://openai.com/brand/). The page refused automated reads, so its rule was read through a search index, not the page | Matrix: Mac 11-04 |
| OpenCode | `opencode-logo-dark-square.svg`, `opencode-logo-light-square.svg` | [anomalyco/opencode](https://github.com/anomalyco/opencode) `packages/console/app/src/asset/brand/` at `0dffb96c`, 2026-11-05, the files [opencode.ai/brand](https://opencode.ai/brand) offers | Repo MIT; no separate licence for the mark | No restriction stated; its terms have no logo clause | Matrix: Mac 11-04, 1.19.4 |
| Qwen Code | `qwen-code-logo.svg`, drawn mono | [QwenLM/qwen-code](https://github.com/QwenLM/qwen-code) `packages/desktop/bootstrap/` at `7bd78683`, 2026-11-05 | Repo Apache-2.0, which grants no trademark rights | No published rule found | Matrix: Mac 11-04, 0.26.2 |
| DeepSeek Harness | `deepseek-harness-favicon.svg`, `deepseek-harness-favicon-dark.svg` | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) `apps/web/public/` at `fcc0ad46`, 2026-11-05 | Repo MIT; no separate licence for the mark | No published rule found | Matrix: Mac, private pods, 10-23 and 10-28 |
| Hosted agent | Inline, from `frontend/design-system/assets/commonly-mark.svg` | Ours | Ours | Ours | Hosted reply walked on prod, 2026-11-05 |
| MCP client | `mcp-mark-black.svg`, `mcp-mark-white.svg` | [modelcontextprotocol](https://github.com/modelcontextprotocol/modelcontextprotocol) `docs/logo/light.svg`, `dark.svg` at `3c4d91b7`, 2026-11-05. Three mark paths kept byte for byte, wordmark dropped, `viewBox` set | Repo Apache-2.0 and MIT, docs CC-BY-4.0; the mark is an LF Projects trademark | **Requires written permission** for logos on websites or marketing. [LF Projects trademark policy](https://lfprojects.org/policies/trademark-policy/) | Matrix: Claude Code on Mac 11-04 |

## Apps

| Entry | File | Source, date | Licence | Vendor's rule | Walk |
|---|---|---|---|---|---|
| Linear | `linear-logo-dark.svg`, `linear-logo-light.svg` | [Brand bundle](https://static.linear.app/design-assets/Linear-Brand-Assets.zip?v=3) from [linear.app/brand](https://linear.app/brand), 2026-11-05, renamed from `logo-dark.svg`, `logo-light.svg` | Proprietary, no licence | Allows the logomark "for tight layouts or logo-only grids". Forbids altering the files, combining them with other graphics, or implying a relationship; asks for written consent | 2026-10-15, fresh account. Not re-walked on this build. Connected read only |
| GitHub | `github-invertocat-black.svg`, `github-invertocat-white.svg` | [GitHub logo bundle](https://brand.github.com/GitHub_Logos.zip), 2026-11-05 | Proprietary, no licence | Allows a permitted logo to show an integration. No implied affiliation, no changes to colour or dimensions, less prominent than our own name. [brand.github.com](https://brand.github.com/foundations/logo) | Read 2026-11-04, from a non-allowlisted account. Connected read only |
| Telegram | `telegram-t-logo.svg`, drawn tone | [telegram.org/img/t_logo.svg](https://telegram.org/img/t_logo.svg), Telegram's own host, 2026-11-05 | Proprietary, no licence | **Permission unclear, and the file is recoloured.** [Logos page](https://telegram.org/tour/screenshots) allows illustrative use if people understand you don't represent Telegram; [API terms](https://core.telegram.org/api/terms) bar using the logo for apps; read through a search index, not the pages | 2026-11-04, on our own accounts. No outside team has used it, and the page must not suggest one has |
| Slack | `slack-logo.svg`, drawn mono | [a.slack-edge.com](https://a.slack-edge.com/1f40066/marketing/img/nav/logo.svg), the mark on [Slack's media kit page](https://slack.com/media-kit), 2026-11-05. Slack's [logo downloads](https://salesforce.widencollective.com/c/yn6bxnam) were not fetched | Proprietary, no licence | **Requires approval.** [Media kit](https://slack.com/media-kit): uses its guidelines don't cover need approval, through a support request with a mockup. No rule for a third-party integration was found there, and the full guidelines site did not load | Walked 2026-11-02 and 2026-09-26/27 on our own workspace. Public distribution is on. No outside workspace has installed it. Not in the Slack Marketplace |
