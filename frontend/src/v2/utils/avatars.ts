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

// ── Deliberate diversity in the picker grid (Sam, 2026-08-21) ───────────────
//
// A grid of 8 random rolls can hand a user 8 similar faces and nothing that
// looks like them. So the picker's 8 cells are CURATED, not rolled: cell i
// pins skin tone i of bigSmile's full range (lightest → deepest, one each, so
// every grid spans the whole range), and alternates between the two hair
// presentation groups. The seed still personalizes everything else — which
// style within the group, hair color, eyes, mouth — so two users' grids stay
// different while both stay representative.
//
// Natural browns/black plus two warm dyes. Deliberately excludes bigSmile's
// violet/teal hair, which fights the tinted backgrounds.
const HAIR_COLORS = ['220f00', '3a1a00', '71472d', 'd56c0c', 'e9b729'] as const;
// Everyday accessories only — the default set includes clown noses and cat
// ears, which is the wrong register for a colleague's face. Mustache appears
// only in male-leaning archetype cells below, never in the shared default.
const ACCESSORIES = ['glasses', 'sunglasses', 'mustache'] as const;

// ── The archetype grid (Sam, 2026-08-21: "Asian male female, Caucasian ones,
// black ones brown ones") ───────────────────────────────────────────────────
//
// Ethnic representation in bigSmile is expressed through the three levers the
// style exposes: skin tone + hair style + hair color. The 24 cells are
// CURATED combinations, laid out as 4 rows of 6 — East Asian, Caucasian,
// brown (South Asian / Latino / MENA), Black — each row 3 female-leaning +
// 3 male-leaning looks. The seed still personalizes within a cell (which
// style from its list, which color, eyes, mouth), so two users' grids differ
// while both cover the same ground. Mustache is offered only in male-leaning
// cells.
//
// Cells derive from the `-v<n>` suffix (see presetCharacterOptions in
// utils/avatarUtils), so stored values stay plain seeds — zero storage or
// backend changes. (`as const`-friendly literal arrays throughout: dicebear
// types these fields as literal-union arrays, so widened string[] does not
// compile.)
const F_ACC = ['glasses', 'sunglasses'] as const;
const M_ACC = ['glasses', 'sunglasses', 'mustache'] as const;

interface PickerArchetype {
  skin: string[];
  hair: string[];
  color: string[];
  acc: string[];
}

export const PICKER_ARCHETYPES: PickerArchetype[] = ([
  // Row 1 — East Asian: light tones, black straight-leaning hair
  { skin: ['ffe4c0'], hair: ['straightHair', 'bangs'], color: ['220f00'], acc: F_ACC },
  { skin: ['f5d7b1'], hair: ['bunHair', 'wavyBob'], color: ['220f00', '3a1a00'], acc: F_ACC },
  { skin: ['efcc9f'], hair: ['bangs', 'bunHair'], color: ['220f00'], acc: F_ACC },
  { skin: ['ffe4c0'], hair: ['shortHair', 'bowlCutHair'], color: ['220f00'], acc: M_ACC },
  { skin: ['f5d7b1'], hair: ['shortHair', 'straightHair'], color: ['220f00'], acc: M_ACC },
  { skin: ['efcc9f'], hair: ['curlyShortHair', 'shortHair'], color: ['220f00', '3a1a00'], acc: M_ACC },
  // Row 2 — Caucasian: light tones, blonde / brown / ginger
  { skin: ['ffe4c0'], hair: ['wavyBob', 'curlyBob'], color: ['e9b729', 'd56c0c'], acc: F_ACC },
  { skin: ['f5d7b1'], hair: ['straightHair', 'bangs'], color: ['71472d', 'e2ba87'], acc: F_ACC },
  { skin: ['ffe4c0'], hair: ['bunHair', 'wavyBob'], color: ['3a1a00', '71472d'], acc: F_ACC },
  { skin: ['ffe4c0'], hair: ['shortHair', 'curlyShortHair'], color: ['e9b729', '71472d'], acc: M_ACC },
  { skin: ['f5d7b1'], hair: ['shortHair', 'mohawk'], color: ['3a1a00', 'd56c0c'], acc: M_ACC },
  { skin: ['efcc9f'], hair: ['curlyShortHair', 'shavedHead'], color: ['71472d'], acc: M_ACC },
  // Row 3 — brown (South Asian / Latino / MENA): mid tones, dark hair
  { skin: ['e2ba87'], hair: ['straightHair', 'wavyBob'], color: ['220f00', '3a1a00'], acc: F_ACC },
  { skin: ['c99c62'], hair: ['braids', 'bunHair'], color: ['220f00'], acc: F_ACC },
  { skin: ['e2ba87'], hair: ['curlyBob', 'bangs'], color: ['3a1a00'], acc: F_ACC },
  { skin: ['e2ba87'], hair: ['shortHair', 'curlyShortHair'], color: ['220f00', '3a1a00'], acc: M_ACC },
  { skin: ['c99c62'], hair: ['shortHair', 'shavedHead'], color: ['220f00'], acc: M_ACC },
  { skin: ['c99c62'], hair: ['curlyShortHair', 'mohawk'], color: ['220f00'], acc: M_ACC },
  // Row 4 — Black: deep tones, textured styles
  { skin: ['a47539'], hair: ['braids', 'froBun'], color: ['220f00'], acc: F_ACC },
  { skin: ['8c5a2b'], hair: ['curlyBob', 'bunHair'], color: ['220f00'], acc: F_ACC },
  { skin: ['643d19'], hair: ['braids', 'curlyBob'], color: ['220f00'], acc: F_ACC },
  { skin: ['8c5a2b'], hair: ['curlyShortHair', 'froBun'], color: ['220f00'], acc: M_ACC },
  { skin: ['643d19'], hair: ['shavedHead', 'shortHair'], color: ['220f00'], acc: M_ACC },
  { skin: ['a47539'], hair: ['halfShavedHead', 'curlyShortHair'], color: ['220f00'], acc: M_ACC },
] as Array<{ skin: readonly string[]; hair: readonly string[]; color: readonly string[]; acc: readonly string[] }>)
  .map((a) => ({ skin: [...a.skin], hair: [...a.hair], color: [...a.color], acc: [...a.acc] }));

export const PICKER_CELL_COUNT = PICKER_ARCHETYPES.length;

const variantTraits = (key: string) => {
  const m = /-v([1-9]|1[0-9]|2[0-4])$/.exec(key);
  if (!m) return null;
  const cell = PICKER_ARCHETYPES[Number(m[1]) - 1];
  if (!cell) return null;
  return {
    skinColor: cell.skin,
    hair: cell.hair,
    hairColor: cell.color,
    accessories: cell.acc,
    accessoriesProbability: 20,
  };
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
  const options = {
    seed: key,
    backgroundColor: [backgroundFor(key, kind).slice(1)],
    hairColor: [...HAIR_COLORS],
    accessories: [...ACCESSORIES],
    accessoriesProbability: 25,
    ...variantTraits(key),
  };
  try {
    // Cast: the archetype table's fields are runtime string[]s, but dicebear
    // types every option as a literal-union array. The table's values are
    // pinned by the avatarCharacter tests against the RENDERED SVG, which is
    // a stronger guarantee than the compile-time enum the cast gives up.
    return createAvatar(bigSmile, options as Parameters<typeof createAvatar>[1]).toDataUri();
  } catch {
    return null;
  }
};
