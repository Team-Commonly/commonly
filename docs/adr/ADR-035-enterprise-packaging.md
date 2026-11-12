# ADR-035: Enterprise packaging and the open-core boundary

**Status:** **Accepted** 2026-11-12: option A, ratified by the project's cofounder under the founder's standing delegation, and reversible by the founder. Nothing here is built until an outside organisation asks for one of the candidate features. Acknowledged unknowns: no enterprise feature exists yet, the candidate list below is unconfirmed, enterprise prices are unset (GTM proposes, the founder decides), and the `ee/` license text is unwritten (counsel reviews it before any `ee/` code merges).

**Owners:** CTO (license mechanism, this ADR), GTM (packaging and pricing copy), the cofounder (ratified), the founder (may reverse; decides prices). Ledger row D116.

## Context

Sam, 10-27: "we need to start thinking about licensed based or plan based enterprise features (license meaning for self host) like this one". "This one" was the Fleet health page (D115, `docs/architecture/fleet-health.md`).

What Commonly has published binds this decision:
- **The license.** The repository is Apache-2.0 (`LICENSE`).
- **The pricing page** (`landing.pricing` in `frontend/src/i18n/locales/en.json`) says:
  - "Self-host free forever under Apache-2.0", with "Unlimited humans, agents, and pods" and "Fork it, audit it";
  - agents people bring "connect free and unlimited — on every tier, forever";
  - "Never per agent" and "Flat $12 per human".
- **The plans.** Cloud free and Pro, where Pro sells history, Community listing and a higher hosted-agent turn cap. The page already has an Enterprise row: "private or dedicated deployment, SLAs, and a security review. SSO/SAML is planned."
- **The pricing test.** `frontend/src/v2/__tests__/pricing-copy-invariants.test.ts` pins:
  - that no priced tier claims "free";
  - that history is a ceiling;
  - that Pro's unlimited history covers pods you create;
  - the turn caps;
  - that no SSO, SAML or federation claim appears beyond the one phrase "SSO/SAML is planned".

  It does not pin the self-host or BYO promises above. Those bind as published text.

## Decision drivers

1. **No take-backs.** Whatever is Apache-2.0 today stays Apache-2.0 and stays in the core. A feature never moves from core to enterprise.
2. **The kernel is never enterprise.** CAP, identity, memory, events, grants, the drivers and the shell a small team needs all stay in core. An enterprise feature sits on top of the kernel and never forks it.
3. **One codebase.** Self-host enterprise and the cloud Enterprise plan run the same code, so a feature is built once.
4. **Enterprise means organisations,** not more of the same. It is features a company needs because it is a company: its own identity provider, compliance, oversight across many teams. A single team should never hit an enterprise wall.
5. **Enterprise never caps what is promised.** No enterprise code may limit the number of humans, agents or pods, or BYO connections, on any tier. The free Self-host tier never needs anything outside the Apache-2.0 code.

## Candidate enterprise features

These are candidates, unconfirmed; the founder may strike any of them:
- The organisation-wide Fleet health view (D115). The first version, covering pods the viewer is a member of, stays core. A view across every pod in an organisation, which needs a role and an audit line of its own, is the enterprise candidate.
- SSO to an organisation's own identity provider (SAML or OIDC) and SCIM provisioning. Google and GitHub sign-in are core today and stay core by driver 1.
- Audit log export and record export, with longer retention controls.
- Approval policy and org-wide rules: who may install which agent, which connectors are allowed.
- Org admin: many workspaces under one owner, roles above pod admin.

Never enterprise: anything that makes agents work in a pod, any privacy or security fix, BYO connections, self-host install itself.

## Options

### A. Open core with a separate enterprise directory (recommended)
- Enterprise code lives in `ee/` in this repository under a source-available commercial license (the GitLab and Cal.com pattern). Everything outside `ee/` stays Apache-2.0.
- Self-hosters run it with a license key. Without a key, `ee/` features are off and the rest is unchanged.
- The cloud Enterprise plan turns the same flags on.
- **For:** one codebase, auditable source, and a clear line a contributor can see.
- **Against:**
  - the repository is no longer wholly Apache-2.0;
  - contributors need a CLA or a DCO note for `ee/`;
  - the license-key check is code we maintain;
  - some people treat any non-OSI directory as a red flag.

### B. Enterprise in a separate private repository
- A closed plugin package loads into the Apache core through an extension point.
- **For:** the public repository stays wholly Apache-2.0, and nothing commercial is visible.
- **Against:**
  - two repositories to keep in step;
  - extension points have to be designed before the first feature;
  - self-hosters can't audit what they run.

### C. Cloud-only enterprise, no self-host license
- Enterprise features exist only on commonly.me.
- **For:** no license mechanism at all, which is the simplest option.
- **Against:**
  - it refuses the self-host enterprise buyer Sam named;
  - regulated companies that must self-host have no path.

## Recommendation

Option A. `ee/` is created only when an outside organisation asks for one of the candidates and that feature is built; until then it doesn't exist and nothing ships under it.

The license key is an offline-verifiable signed file, with no phone-home. A self-hosted instance never calls us. No published page promises this today, but a self-host buyer will ask, and it is the honest default.

## What this ADR does not decide

- Enterprise prices: GTM proposes, Sam decides.
- The exact license text for `ee/`: counsel reviews before any `ee/` code merges.
- Whether any current Pro feature changes: it doesn't, by driver 1.

## Consequences

- **The license carve-out.** `LICENSE` and the README gain a note that `ee/` is under its own license and everything else is Apache-2.0. The Self-host tier's "Apache-2.0" and "Fork it, audit it" stay true, because by driver 5 that tier never needs `ee/`.
- **A boundary test.** Core code never imports from `ee/`. It is enforced in CI the day `ee/` gets its first file.
- **Pricing copy.** The Enterprise row changes only when a feature behind it ships, and GTM writes that copy. Turning "SSO/SAML is planned" into an offer also means changing the SSO rule in `pricing-copy-invariants.test.ts` in the same change. That same change adds the self-host and BYO promises to the test, so they are pinned and not only published text.
- **Scope doc.** `docs/COMMONLY_SCOPE.md` gains one line naming the boundary.
