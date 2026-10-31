# Landing "Trusted by people from" banner: provenance

The landing page's rolling banner names 24 organisations that people using Commonly come from. This page is the record behind it: for each org, why it is on the banner, where its logo file came from, what licence or permission the source states, what the org's own brand policy says, and what we changed in the file.

- Code: `TRUSTED_AFFILIATIONS` in `frontend/src/v2/landing/V2LandingPage.tsx`; files in `frontend/public/logos/`; styling in `.v2-landing__trusted*` in `frontend/src/v2/landing/v2-landing.css`.
- Issue #708 records the affiliation basis for the original eleven orgs only. It has **no** logo records. Earlier code comments said it held each logo's source and licence. That was false, and this page replaces it.
- An addition to the banner is a data change in `TRUSTED_AFFILIATIONS` plus a row here, in the same PR.

## What the banner claims, and what it does not

The banner says people from these organisations use Commonly. It does not say any organisation endorses, partners with or has approved Commonly.

**A logo taken from an organisation's own website carries no licence.** We show these logos only to identify where our users come from. **Any organisation can ask for its name or logo to be removed, and we take it down the same day.** To ask, open an issue on the public Commonly repository or contact us through commonly.me.

Eight of the original orgs, and the University of Illinois, publish a brand rule that forbids this use or requires prior approval for it. On 2026-10-25 the decision was to show their logos anyway, on the same-day-removal terms above. The **Brand policy** column keeps each org's stated rule so that decision stays visible. It is not overridden.

## How every logo is drawn

Every logo is drawn as one grey silhouette, whatever colours its file carries: CSS `filter: grayscale(1) brightness(0)` at `opacity: 0.6`, 26px tall (22px at ≤680px). Hovering raises the opacity and leaves the colours alone. This changes how the file is drawn, not the file. It is also what keeps the white artwork (OROZ, and Fluxr's wordmark) visible on the light strip. One side effect: a mark that sits inside a solid tile becomes a solid tile (OROZ's icon square). The wordmark beside it still reads.

`width` in the code is the file's intrinsic aspect ratio × 26. `frontend/src/v2/landing/__tests__/trustedLogoDimensions.test.ts` re-derives it from the file.

## Affiliation basis, in three kinds

- **signup from org domain**: at least one registered user signed up with an email address on the organisation's own domain.
- **team/collaborator affiliation**: a member of the team or a close collaborator works or worked there.
- **founder-vouched**: the users registered with personal email addresses, and a founder attests to the affiliation.

The basis for the original eleven is copied from #708. The thirteen added on 2026-10-25 are all signups from the org's domain, read from production that day.

## The record

Abbreviations: **PD** is public domain. **Decision 10-25** means "decision of 10-25 — remove same day on request". Files fetched on 2026-10-25 are marked *(fetched 10-25)*.

| Org | Display | Logo file | Source URL | Licence as stated at source | Permission | Brand policy (org's stated rule) | Modifications to the file | Affiliation basis |
|---|---|---|---|---|---|---|---|---|
| Arista | logo | `arista.svg` | https://commons.wikimedia.org/wiki/File:Arista-networks-logo.svg (byte match). Commons credits Brandlogos.net and cites an Arista product PDF. | PD on Commons, tagged trademarked | Decision 10-25 | Express written permission needed to use its logo. https://www.arista.com/en/trademark-usage-guidelines | none | team/collaborator affiliation |
| UCLA | logo | `ucla.svg` | https://commons.wikimedia.org/wiki/File:University_of_California,_Los_Angeles_logo.svg (byte match). Commons credits the UCLA Arts Brand Guide. | PD on Commons, tagged trademarked | Decision 10-25 | Bans advertising that lists the University as a user of a product. https://campuscounsel.ucla.edu/quick-references/use-of-name | none | signup from org domain |
| Rice University | logo | `rice.svg` | https://brand.rice.edu/sites/g/files/bxs5371/files/2019-07/Rice_University_Horizontal_Blue.svg, the horizontal logo in brand.rice.edu's own header *(fetched 10-25)*. It replaces the previous file, an en.wikipedia non-free upload (`File:Rice_Logo_280_Blue.svg`). | None stated (official brand asset) | Decision 10-25 | Prior written permission. https://brand.rice.edu/policies | `width`/`height` attributes changed from 525×75 to 550×80 to match the file's own viewBox (275×40). The mismatch letterboxed the art. Paths unchanged. | signup from org domain |
| Peking University | logo | `pku.png` | Source unknown. https://www.pku.edu.cn/pku_logo_red.png is a different file (the seal only). | Unknown | none recorded | No third-party clause found in the university's VI manual | none known | signup from org domain |
| University of Pennsylvania | logo | `upenn.svg` | https://commons.wikimedia.org/wiki/File:University_of_Pennsylvania_wordmark.svg (byte match). Commons credits Penn's style guide. | PD on Commons, tagged trademarked | Decision 10-25 | Prior approval of the Secretary. https://secretary.upenn.edu/trustees-governance/use-university-name | none | founder-vouched |
| Yale University | logo | `yale.svg` | Source unknown. No byte match on Wikimedia Commons or en.wikipedia. | Unknown | Decision 10-25 | Written approval needed; a text client listing is allowed. https://licensing.yale.edu/use-yale-name/outside-consultants-and-contractors | none known | founder-vouched |
| Columbia University | logo | `columbia.svg` | https://commons.wikimedia.org/wiki/File:Columbia_University_1754_updated.svg (byte match) | **CC BY-SA 4.0**, attribution required. See the attribution line below this table. | Decision 10-25 | Forbids its marks in non-University promotion. https://cufo.columbia.edu/content/guidelines-use-columbia-marks | none to the file. It is drawn in grey by CSS. | founder-vouched |
| McMaster University | logo | `mcmaster.svg` | Source unknown. No byte match on Wikimedia Commons or en.wikipedia. | Unknown | Decision 10-25 | Not for commercial use. https://brand.mcmaster.ca/?p=1624 | none known | founder-vouched |
| University of Illinois | logo | `illinois.svg` | The inline campus wordmark SVG in the https://illinois.edu/ header *(fetched 10-25)*. It came in through PR #2669. | None stated (official site asset) | Decision 10-25 | Prior approval. https://brand.illinois.edu/applying-the-brand/trademarks-and-licensing | `.st0` fill recoloured from white to `#101828`, so the file reads on a light ground | signup from org domain |
| ByteDance | logo | `bytedance.svg` | https://commons.wikimedia.org/wiki/File:ByteDance_logo_English.svg (exact byte match) | PD-textlogo on Commons, tagged trademarked | none recorded | No published policy found | none | team/collaborator affiliation |
| Microsoft | logo | `microsoft.svg` | https://commons.wikimedia.org/wiki/File:Microsoft_logo_(2012).svg (byte match) | PD on Commons, tagged trademarked | Decision 10-25 | No logo use without a licence. https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks | none | team/collaborator affiliation |
| Ajaib | logo | `ajaib.svg` | Its own site header: https://storage.googleapis.com/storage-ajaib-prd-platform-web-landing/_next/static/media/ajaib-logo.423d79d0.svg, as rendered on https://ajaib.co.id | No licence stated | none recorded | No published policy found | none | signup from org domain |
| OROZ | logo | `oroz.png` | https://www.oroz.com.br/_next/static/immutable/media/oroz-assinatura-branca.3id2jbf392lp2.png, from the oroz.com.br header *(fetched 10-25)* | No licence stated | none recorded | None located | Downscaled from 1793×512 to 182×52. White artwork. It shows only because of the silhouette filter. | signup from org domain |
| CLCK | logo | `clck.svg` | https://www.clck.com.au/assets/clck-wordmark-violet.svg *(fetched 10-25)* | No licence stated | none recorded | None located | none | signup from org domain |
| Ollow | logo | `ollow.svg` | https://www.ollow.com.br/hubfs/Logo%20espa%C3%A7ado.svg, named as the logo in the homepage schema *(fetched 10-25)* | No licence stated | none recorded | None located | viewBox, `width` and `height` trimmed from `0 0 222 83` to `8.5 11.5 205.5 50`, the artwork's own bounds. The spacing in the file had drawn the mark at about 15px. Paths unchanged. | signup from org domain |
| Verifran | logo | `verifran.png` | https://verifran.com/brand/verifran-logo-no-tagline.webp *(fetched 10-25)*. A PNG of the same name sits beside it. | No licence stated | none recorded | None located | Converted from WebP to PNG, transparent margin trimmed, downscaled to 150×52 | signup from org domain |
| AIMS | logo | `aims.svg` | The inline letter SVGs in `h1.title` on https://aims-ai.tokyo/ *(fetched 10-25)*. It came in through PR #2669. The site has no single logo file. | No licence stated | none recorded | None located | The four letter SVGs are placed as the live page renders them. Fill recoloured from white to `#101828`. The "AI HUMANS" sub-line is dropped. It replaces the favicon (https://aims-ai.tokyo/favicon.png), a lime tile that the silhouette filter turned into a solid square. | signup from org domain |
| Fluxr | logo | `fluxr.svg` | The inline data-URI SVG in the https://fluxr.com/landing/en/ header *(fetched 10-25)* | No licence stated | none recorded | None located | none. The white wordmark shows only because of the silhouette filter. The gradient mark's `url(#…)` fills are internal references. | signup from org domain |
| Cyber Solutions | logo | `cybsolutions.png` | https://discovercybersolutions.com/assets/cyber-solutions-logo-DOAN9ytD.png. cybsolutions.com redirects there *(fetched 10-25)*. | No licence stated | none recorded | None located | Downscaled from 450×69 to 338×52 | signup from org domain |
| Altur | logo | `altur.svg` | https://www.altur.io/svg/logo.svg *(fetched 10-25)* | No licence stated | none recorded | None located | none | signup from org domain |
| ILOapps | logo | `iloapps.png` | https://iloapps.com/img/iloapps-logo-wide-white.png, the site's og:image *(fetched 10-25)*. It came in through PR #2669. It replaces the square icon (https://iloapps.com/img/iloapps-icon-transparent.png), which read at about 10px a line at 26px. | No licence stated | none recorded | None located | Background made transparent (in #2669), downscaled to 361×52 | signup from org domain |
| Rivne Tech | logo | `rivnetech.png` | https://www.rivnetech.com/Logo/logo-ink.png *(fetched 10-25)* | No licence stated | none recorded | None located | Transparent margin trimmed, downscaled to 379×52 | signup from org domain |
| NewTech Kuwait | logo | `newtechkw.png` | https://newtechq8.com/cdn/shop/files/Copy_of_NewTech_4.png. newtechkw.com redirects there *(fetched 10-25)*. | No licence stated | none recorded | None located | Transparent margin trimmed, downscaled to 117×52 | signup from org domain |
| Ada | logo | `ada.svg` | The inline SVG in the https://www.ada.cx header *(fetched 10-25)* | No licence stated | none recorded | None located | none | signup from org domain: ada.support. That domain 301-redirects to ada.cx, and Ada's privacy policy gives @ada.support contact addresses. |

**Columbia attribution (CC BY-SA 4.0).** "Columbia University 1754 updated.svg" by ArredondoC-alejandro, via Wikimedia Commons, https://commons.wikimedia.org/wiki/File:Columbia_University_1754_updated.svg, licensed CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0). The repository ships the file unchanged. The landing page draws it in grey with CSS. This attribution is recorded here and pointed to from the code comment above `TRUSTED_AFFILIATIONS`. It is not shown as visible chrome on the banner.

"None located" means that while sourcing the file we found no published brand or trademark policy on the org's site. It does not mean we searched exhaustively.

## Change log

- **2026-10-25.** The banner grew from 11 to 24 orgs. Every entry is a logo. A text-name variant for the eight policy-restricted orgs and Illinois was drafted and then reversed by a decision the same day. Rice's file was replaced with the official brand.rice.edu asset. Every logo now renders as one grey silhouette. The marquee went from 42s to 99s, which keeps the scroll speed at about 42px/s for a set that measures 4,145px at 1440. This page replaced the #708 citations in the code.
