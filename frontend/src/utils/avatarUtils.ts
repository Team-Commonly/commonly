import { normalizeUploadUrl } from './apiBaseUrl';

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
  return isLikelyImageUrl(avatarId) ? normalizeUploadUrl(avatarId) : null;
};
