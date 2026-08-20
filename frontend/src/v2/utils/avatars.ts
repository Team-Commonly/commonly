// Avatar background tints. Blue-forward and cohesive with the design system's
// single accent (#2f6feb) — deliberately purple-free (the old palette led with
// two bright violets, #6d5dfc/#7367c7, and defaulted un-seeded avatars to purple,
// which read as "the app is purple"). All values are dark enough for legible white
// initials. The brand blue is first, so it is also the default for an empty seed.
const AVATAR_PALETTE = [
  '#2f6feb', // brand blue
  '#0e7490', // cyan
  '#0f766e', // teal
  '#15803d', // green
  '#b45309', // amber
  '#be123c', // rose
  '#3b82a0', // steel blue
  '#475569', // slate
];

const hashString = (input: string): number => {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
};

export const colorFor = (seed: string | undefined | null): string => {
  if (!seed) return AVATAR_PALETTE[0];
  return AVATAR_PALETTE[hashString(String(seed)) % AVATAR_PALETTE.length];
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
