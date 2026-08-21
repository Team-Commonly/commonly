// eslint-disable-next-line import/no-extraneous-dependencies
import { createAvatar } from '@dicebear/core';
// eslint-disable-next-line import/no-extraneous-dependencies
import { bigSmile } from '@dicebear/collection';

// Avatar tints. Blue-forward and cohesive with the design system's single
// accent (#2f6feb) — deliberately purple-free (the old palette led with two
// bright violets, #6d5dfc/#7367c7, and defaulted un-seeded avatars to purple,
// which read as "the app is purple"). All values are dark enough for legible
// white initials. The brand blue is first, so it is also the default for an
// empty seed.
//
// Each entry carries its own gradient partner rather than deriving one, because
// a computed lighten/darken drifts across hues: the same +12% lightness that
// flatters the teal washes the amber out. Both stops are hand-picked to stay
// above the contrast floor for white text.
interface AvatarTint {
  base: string;
  to: string;
}

const AVATAR_PALETTE: AvatarTint[] = [
  { base: '#2f6feb', to: '#1f55c9' }, // brand blue
  { base: '#0e7490', to: '#0b5c73' }, // cyan
  { base: '#0f766e', to: '#0b5c56' }, // teal
  { base: '#15803d', to: '#106430' }, // green
  { base: '#b45309', to: '#8f4207' }, // amber
  { base: '#be123c', to: '#980e30' }, // rose
  { base: '#3b82a0', to: '#2f6880' }, // steel blue
  { base: '#475569', to: '#374254' }, // slate
];

const hashString = (input: string): number => {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
};

/**
 * A second, independent hash for the gradient angle.
 *
 * Deriving both the tint and the angle from `hashString` correlates them: two
 * seeds that collide on the palette tend to collide on the angle too, and the
 * result is two agents rendering *identically*. That is not a cosmetic problem
 * — "Sprint Review" and "Pod Architect" collided on both under the single-hash
 * version, and they are the two most active seats in the pod. An avatar whose
 * job is to say who spoke must not say the same thing for two people.
 *
 * Different multiplier and a reversed walk, so the two hashes disagree on
 * inputs of the length real display names actually have.
 */
const angleHash = (input: string): number => {
  let hash = 7;
  for (let i = input.length - 1; i >= 0; i -= 1) {
    hash = (hash * 131 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
};

const tintFor = (seed: string | undefined | null): AvatarTint => {
  if (!seed) return AVATAR_PALETTE[0];
  return AVATAR_PALETTE[hashString(String(seed)) % AVATAR_PALETTE.length];
};

/**
 * Flat tint for the seed. Retained as the single source of the hue so anything
 * that needs a solid colour (borders, focus rings, a chart key) agrees with the
 * avatar rather than picking its own.
 */
export const colorFor = (seed: string | undefined | null): string => tintFor(seed).base;

/**
 * Seeded gradient. The angle is seeded too — a fixed angle across every avatar
 * reads as a template, and the whole point of a default avatar is that two
 * agents side by side look like different individuals rather than one component
 * rendered twice.
 */
export const gradientFor = (seed: string | undefined | null): string => {
  const { base, to } = tintFor(seed);
  const angle = seed ? 105 + (angleHash(String(seed)) % 8) * 22 : 135;
  return `linear-gradient(${angle}deg, ${base} 0%, ${to} 100%)`;
};

export const initialsFor = (name: string | undefined | null): string => {
  const raw = String(name || '').trim();
  if (!raw) return '?';

  // Drop parenthetical qualifiers before picking initials. Display names here
  // routinely carry a role or runtime in brackets — "Fable (lead)", "Critic
  // (Codex)", "Codex (impl)" — and first-word + last-word was taking the
  // BRACKET as the second initial. Four of the twelve cards on Your Team read
  // "F(", "C(", "S(" and "C(": ugly, and wrong in a way that matters, because
  // "Critic (Codex)" and "Codex (impl)" rendered IDENTICALLY. Two different
  // agents labelled the same is the attribution failure this repo has paid for
  // before with displayName collisions.
  //
  // A parenthetical is a qualifier rather than part of the name, so dropping it
  // also yields the more distinctive initials: Critic -> CR, Codex -> CO.
  const trimmed = raw.replace(/\([^)]*\)/g, ' ').trim() || raw;

  // Strip residual punctuation from each token so a stray bracket, comma or
  // colon can never become an initial again. Unicode-aware, so a CJK display
  // name keeps its characters instead of being emptied to "?".
  const parts = trimmed
    .split(/[\s_\-/|]+/)
    .map((part) => part.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);

  if (parts.length === 0) return trimmed.slice(0, 2).toUpperCase() || '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
};

// ── Character tier ──────────────────────────────────────────────────────────
//
// Sam's ruling (2026-08-21, revising 2026-08-20): bigSmile faces for BOTH
// species — the bottts robots read as ugly in practice. Species still has to
// be legible at a glance in mixed chat, so the kind now selects the
// BACKGROUND family instead of the art style: humans sit on warm tints,
// agents on cool ones. The two sets are disjoint on purpose.
//
// The stored prefixes ('bigsmile:' / 'bottts:') are SPECIES TAGS on the wire,
// not artwork names — 'bottts:<seed>' means "agent-styled character", and
// after this revision that renders a bigSmile face on an agent tint. Keeping
// the tag stable is what let this revision ship with zero backend changes and
// zero data migration.
//
// Deterministic, local, SVG: same seed, same face, forever. No image API and
// no art pipeline, so install #10,000 costs what install #1 did. That is what
// separates this tier from generated art, which was rejected for exactly
// those costs.
//
// License note that must not rot: bigSmile is CC BY 4.0 — the visible credit
// in the login footer is a LICENSE REQUIREMENT, not decoration. If the style
// is ever swapped, re-check the license and the credit line together.
export type AvatarKind = 'human' | 'agent';

// Disjoint background families — the species signal now that both kinds share
// one art style. Indexes into AVATAR_PALETTE: humans get brand blue / green /
// amber / rose (warm-forward), agents get cyan / teal / steel / slate (cool).
const HUMAN_BG = [0, 3, 4, 5];
const AGENT_BG = [1, 2, 6, 7];

const backgroundFor = (key: string, kind: AvatarKind): string => {
  const family = kind === 'agent' ? AGENT_BG : HUMAN_BG;
  return AVATAR_PALETTE[family[hashString(key) % family.length]].base;
};

/**
 * Data-URI for the character avatar, or null when generation fails — callers
 * fall back to the gradient+initials tier, which cannot fail. The seeded tint
 * becomes the character's background so this tier stays inside the palette
 * rather than introducing new color.
 *
 * Seed on STABLE IDENTITY, not display name — `agentName:instanceId` for
 * agents, userId for humans — so a rename never changes someone's face.
 * Callers that only have a name may pass it, accepting that a rename re-rolls
 * the character.
 */
export const characterAvatarFor = (
  seed: string | undefined | null,
  kind: AvatarKind,
): string | null => {
  const key = String(seed || '').trim();
  if (!key) return null;
  // Same-seed human and agent still must never render identically (the
  // species-legibility rule) — the disjoint background families guarantee it
  // even on a face collision.
  const options = { seed: key, backgroundColor: [backgroundFor(key, kind).slice(1)] };
  try {
    return createAvatar(bigSmile, options).toDataUri();
  } catch {
    return null;
  }
};
