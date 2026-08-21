import React from 'react';
import { getAvatarSrc } from '../../utils/avatarUtils';
import {
  characterAvatarFor, gradientFor, initialsFor, AvatarKind,
} from '../utils/avatars';

export type V2AvatarSize = 'sm' | 'md' | 'lg';

interface V2AvatarProps {
  name?: string | null;
  src?: string | null;
  size?: V2AvatarSize;
  online?: boolean;
  title?: string;
  /**
   * Renders the character tier: bigSmile faces for both kinds, with the
   * species carried by disjoint background families ('human' warm, 'agent'
   * cool — Sam's 2026-08-21 revision). Omitted → gradient+initials, unchanged
   * — callers that cannot tell who they are drawing must not guess, because
   * mislabelling the tier mislabels the PERSON's species tint.
   * An uploaded photo always wins over both tiers.
   */
  kind?: AvatarKind;
  /**
   * Stable identity for the character seed — `agentName:instanceId` or a
   * userId — so a display-name change never changes the face. Falls back to
   * `name` when absent.
   */
  seed?: string | null;
}

const sizeClass = (size: V2AvatarSize): string => {
  switch (size) {
    case 'sm': return 'v2-avatar v2-avatar--sm';
    case 'lg': return 'v2-avatar v2-avatar--lg';
    case 'md':
    default:
      return 'v2-avatar v2-avatar--md';
  }
};

const V2Avatar: React.FC<V2AvatarProps> = ({
  name, src, size = 'md', online, title, kind, seed: seedProp,
}) => {
  const seed = String(name || '');
  const bg = gradientFor(seed);
  const initials = initialsFor(seed);
  const display = title || seed || undefined;
  const rawSrc = typeof src === 'string' && src.trim().length > 0 ? src.trim() : null;
  // getAvatarSrc, NOT normalizeUploadUrl. Every User row's profilePicture
  // defaults to the literal string 'default' (models/User.ts), which
  // normalizeUploadUrl passes through untouched — so every default-avatar user
  // rendered <img src="default">, fired a guaranteed 404 relative to the page,
  // and only reached the character/initials tier after the error round-trip.
  // getAvatarSrc (the v1 util) already knows the sentinel ids ('default' and
  // the legacy color names) mean NO IMAGE, and returns null for anything that
  // is not a plausible image reference — no request, no flash, straight to the
  // right tier.
  const cleanSrc = getAvatarSrc(rawSrc) || null;
  const [imgFailed, setImgFailed] = React.useState(false);

  // Character tier (photo still wins, below). Memoized because the SVG build
  // runs per identity per render otherwise, and chat re-renders per message.
  // Falls back to gradient+initials on any generation failure — the character
  // is presentation, never load-bearing.
  const characterSrc = React.useMemo(
    () => (kind ? characterAvatarFor(seedProp || seed, kind) : null),
    [kind, seedProp, seed],
  );

  React.useEffect(() => {
    setImgFailed(false);
  }, [cleanSrc]);

  if (cleanSrc && !imgFailed) {
    return (
      <span
        className={sizeClass(size)}
        style={{ background: bg }}
        title={display}
      >
        <img
          src={cleanSrc}
          alt={display || 'avatar'}
          onError={() => setImgFailed(true)}
          style={{
            width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%',
          }}
        />
        {online && <span className="v2-avatar__online" />}
      </span>
    );
  }

  if (characterSrc) {
    return (
      <span
        className={sizeClass(size)}
        style={{ background: bg }}
        title={display}
      >
        <img
          src={characterSrc}
          alt={display || 'avatar'}
          style={{
            width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%',
          }}
        />
        {online && <span className="v2-avatar__online" />}
      </span>
    );
  }

  return (
    <span
      className={sizeClass(size)}
      style={{ background: bg }}
      title={display}
    >
      {initials}
      {online && <span className="v2-avatar__online" />}
    </span>
  );
};

export default V2Avatar;
