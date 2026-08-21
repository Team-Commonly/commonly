import { normalizeUploadUrl } from './apiBaseUrl';
// eslint-disable-next-line import/no-cycle
import { characterAvatarFor } from '../v2/utils/avatars';

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

export const isFacePresetId = (value: string | undefined | null): boolean => (
  typeof value === 'string' && value.startsWith(FACE_PRESET_PREFIX)
);

/**
 * Eight stable face options for a user. Seeded off their identity so the grid
 * is personal and NEVER reshuffles — a picker whose options change between
 * visits reads as broken, and "the face I picked last month" must still be in
 * the grid when they come back.
 */
export const presetFaceOptions = (seedBase: string): Array<{ id: string; src: string | null }> => (
  Array.from({ length: 8 }, (_, i) => {
    const seed = `${seedBase}-v${i + 1}`;
    return { id: `${FACE_PRESET_PREFIX}${seed}`, src: characterAvatarFor(seed, 'human') };
  })
);

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
  // Picked face preset: regenerate locally from the stored seed. Data-URI out,
  // so every <img>-based consumer renders it with no network involved.
  if (isFacePresetId(avatarId)) {
    return characterAvatarFor(avatarId.slice(FACE_PRESET_PREFIX.length), 'human');
  }
  return isLikelyImageUrl(avatarId) ? normalizeUploadUrl(avatarId) : null;
};
