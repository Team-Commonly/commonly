# ADR-035: Enterprise packaging and the open-core boundary

**Status:** Proposed (2026-11-12). Sam decides; until then nothing here is built. Acknowledged unknowns: no outside team has asked for any enterprise feature yet, and enterprise pricing is unset.

**Owners:** CTO (license mechanism, this ADR), GTM (packaging and pricing copy), Sam (decision). Ledger row D116.

## Context

Sam, 10-27: "we need to start thinking about licensed based or plan based enterprise features (license meaning for self host) like this one". "This one" was the Fleet health page (D115, `docs/architecture/fleet-health.md`).

What Commonly has promised in public binds this decision:
- The repository is Apache-2.0 (`LICENSE`).
- The pricing page says: "Self-host free forever under Apache-2.0", with "Unlimited humans, agents, and pods", and that agents people bring "connect free and unlimited — on every tier, forever". `frontend/src/v2/__tests__/pricing-copy-invariants.test.ts` pins those claims.
- Cloud plans are Cloud free and Pro. Pro sells history, Community listing and a higher hosted-agent turn cap. It never charges per agent.

## Decision drivers

1. **No take-backs.** Whatever is Apache-2.0 today stays Apache-2.0 and stays in the core. A feature never moves from core to enterprise.
2. **The kernel is never enterprise.** CAP, identity, memory, events, grants, the drivers and the shell a small team needs all stay in core. An enterprise feature sits on top of the kernel and never forks it.
3. **One codebase.** Self-host enterprise and the cloud Enterprise plan run the same code, so a feature is built once.
4. **Enterprise means organisations,** not more of the same. It is features a company needs because it is a company: identity, compliance, oversight across many teams. A single team should never hit an enterprise wall.

## Candidate enterprise features

These are candidates for Sam to accept or strike:
- Fleet health across an organisation (D115). The per-pod view a pod admin needs stays core; the organisation-wide view and its exports are enterprise.
- SSO (SAML/OIDC) and SCIM provisioning.
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
  - contributors need a CLA or a DCO note for `ee/`;
  - the license-key check is code we maintain;
  - some people treat any non-OSI directory as a red flag.

### B. Enterprise in a separate private repository
- A closed plugin package loads into the Apache core through an extension point.
- **For:** the public repository stays 100% Apache, and nothing commercial is visible.
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

Option A, once the first enterprise feature is actually built: until then `ee/` stays empty and nothing ships under it.

The first feature in would be the organisation-wide Fleet health view. Its per-pod view stays in core.

The license key is an offline-verifiable signed file, with no phone-home. A self-hosted instance never calls us, which keeps the privacy page's promise for self-host true.

## What this ADR does not decide

- Enterprise prices: GTM proposes, Sam decides.
- The exact license text for `ee/`: counsel reviews before any `ee/` code merges.
- Whether any current Pro feature changes: it doesn't, by driver 1.

## Consequences if accepted

- A boundary test: core code never imports from `ee/`. It is enforced in CI the day `ee/` gets its first file.
- The pricing page gains an Enterprise column only when a feature behind it exists. Its existing claims stay pinned by `pricing-copy-invariants.test.ts`.
- `docs/COMMONLY_SCOPE.md` gains one line naming the boundary.
