import { normalizeUploadUrl } from './apiBaseUrl';
// eslint-disable-next-line import/no-cycle
import { characterAvatarFor, AvatarKind, PICKER_CELL_COUNT } from '../v2/utils/avatars';

interface AvatarOption {
  id: string;
  color: string;
}

export const avatarOptions: AvatarOption[] = [
  { id: 'default', color: 'primary.main' },
  { id: 'red', color: '#e53935' },
  { id: 'purple', color: '#8e24aa' },
  { id: 'blue', color: '#1e88e5' },
  { id: 'teal', color: '#00897b' },
  { id: 'green', color: '#43a047' },
  { id: 'orange', color: '#fb8c00' },
  { id: 'brown', color: '#6d4c41' },
  { id: 'gray', color: '#757575' },
];

export const getAvatarColor = (avatarId: string | undefined | null): string => {
  const avatar = avatarOptions.find((option) => option.id === avatarId);
  return avatar ? avatar.color : 'primary.main';
};


// ── Generated face presets ──────────────────────────────────────────────────
//
// Sam's ruling (2026-08-20): users pick their avatar from a preset of
// GENERATED faces (or upload); the AI image-generation feature is deprecated.
// Deterministic presets beat AI generation on every axis that bit us this
// week: no per-pick API cost, same face forever, and SVG that scales to any
// surface.
//
// Storage scheme: profilePicture = 'bigsmile:<seed>'. The seed — not image
// bytes or a URL — is the identity, so every renderer regenerates the exact
// face locally and nothing 404s, expires, or needs hosting. getAvatarSrc
// resolves the scheme, which means every existing consumer (v1 Avatar src,
// V2Avatar) renders picked faces with zero per-component changes.
export const FACE_PRESET_PREFIX = 'bigsmile:';
// Agents use the same scheme with their own species (Sam: owners can edit an
// agent's avatar too). One resolver, two prefixes — the prefix IS the kind.
export const ROBOT_PRESET_PREFIX = 'bottts:';

const PRESET_KINDS: Array<{ prefix: string; kind: AvatarKind }> = [
  { prefix: FACE_PRESET_PREFIX, kind: 'human' },
  { prefix: ROBOT_PRESET_PREFIX, kind: 'agent' },
];

const presetOf = (value: string | undefined | null) => (
  typeof value === 'string'
    ? PRESET_KINDS.find((p) => value.startsWith(p.prefix)) || null
    : null
);

export const isFacePresetId = (value: string | undefined | null): boolean => (
  presetOf(value) !== null
);

/**
 * The archetype face grid — PICKER_CELL_COUNT curated cells spanning four
 * ethnic rows with female- and male-leaning looks each (traits derive from
 * the -v<n> suffix in v2/utils/avatars). Seeded off the user's identity so
 * the grid is personal and NEVER reshuffles — a picker whose options change
 * between visits reads as broken, and "the face I picked last month" must
 * still be in the grid when they come back.
 */
export const presetFaceOptions = (seedBase: string): Array<{ id: string; src: string | null }> => (
  presetCharacterOptions(seedBase, 'human')
);

export const presetCharacterOptions = (
  seedBase: string,
  kind: AvatarKind,
): Array<{ id: string; src: string | null }> => {
  const prefix = kind === 'agent' ? ROBOT_PRESET_PREFIX : FACE_PRESET_PREFIX;
  return Array.from({ length: PICKER_CELL_COUNT }, (_, i) => {
    const seed = `${seedBase}-v${i + 1}`;
    return { id: `${prefix}${seed}`, src: characterAvatarFor(seed, kind) };
  });
};

const isLikelyImageUrl = (value: string | undefined | null): boolean => {
  if (!value || typeof value !== 'string') return false;
  if (value.startsWith('data:image/')) return true;
  if (value.startsWith('http://') || value.startsWith('https://')) return true;
  if (value.startsWith('/api/uploads/') || value.startsWith('/uploads/')) return true;
  return false;
};

export const getAvatarSrc = (avatarId: string | undefined | null): string | null | undefined => {
  if (!avatarId) return null;
  if (avatarOptions.some((option) => option.id === avatarId)) return null;
  // Picked character preset (face or robot): regenerate locally from the
  // stored seed. Data-URI out, so every <img>-based consumer renders it with
  // no network involved.
  const preset = presetOf(avatarId);
  if (preset) {
    return characterAvatarFor(avatarId.slice(preset.prefix.length), preset.kind);
  }
  return isLikelyImageUrl(avatarId) ? normalizeUploadUrl(avatarId) : null;
};
