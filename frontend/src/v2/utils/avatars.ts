const AVATAR_PALETTE = [
  '#6d5dfc',
  '#64748b',
  '#2f9e8f',
  '#b7791f',
  '#3b82a0',
  '#a8556f',
  '#6b7280',
  '#7367c7',
  '#4b8b73',
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
