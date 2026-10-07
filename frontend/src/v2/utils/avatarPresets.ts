import { PAPER_AVATAR_LOOK_COUNT } from './avatars';

export const PAPER_AVATAR_PREFIX = 'paper:';
export { PAPER_AVATAR_LOOK_COUNT } from './avatars';

const hashString = (input: string): number => {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
};

export const paperAvatarPresetFor = (userId: string, lookIndex: number): string => {
  if (!Number.isInteger(lookIndex) || lookIndex < 0 || lookIndex >= PAPER_AVATAR_LOOK_COUNT) {
    throw new Error(`Paper avatar look index must be between 0 and ${PAPER_AVATAR_LOOK_COUNT - 1}.`);
  }
  const identity = userId.trim();
  if (!identity) throw new Error('A user id is required to select an avatar.');
  return (
    `${PAPER_AVATAR_PREFIX}${identity}-v${lookIndex}`
  );
};

export const defaultPaperAvatarPresetFor = (userId: string): string => {
  const identity = userId.trim();
  if (!identity) throw new Error('A user id is required to select an avatar.');
  return paperAvatarPresetFor(identity, hashString(identity) % PAPER_AVATAR_LOOK_COUNT);
};

/**
 * Step to the next Paper look. An unpicked profile currently shows the
 * identity-seeded default, so the first saved pick advances past that look.
 * A saved Paper pick advances from its explicit cell and wraps after 24.
 */
export const nextPaperAvatarPreset = (userId: string, currentProfilePicture?: string | null): string => {
  const identity = userId.trim();
  if (!identity) throw new Error('A user id is required to select an avatar.');

  const prefix = `${PAPER_AVATAR_PREFIX}${identity}-v`;
  const storedMarker = currentProfilePicture?.startsWith(prefix)
    ? /^(0|[1-9]\d*)$/.exec(currentProfilePicture.slice(prefix.length))
    : null;
  const storedIndex = storedMarker ? Number(storedMarker[1]) : NaN;
  const isStoredPaperPick = Number.isInteger(storedIndex)
    && storedIndex >= 0
    && storedIndex < PAPER_AVATAR_LOOK_COUNT;
  const defaultIndex = Number(defaultPaperAvatarPresetFor(identity).slice(prefix.length));
  const currentIndex = isStoredPaperPick ? storedIndex : defaultIndex;
  const nextIndex = (currentIndex + 1) % PAPER_AVATAR_LOOK_COUNT;

  return paperAvatarPresetFor(identity, nextIndex);
};
