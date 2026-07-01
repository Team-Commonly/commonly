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
  const trimmed = String(name || '').trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/[\s_-]+/).filter(Boolean);
  if (parts.length === 0) return trimmed.slice(0, 2).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
};
