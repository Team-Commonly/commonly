import React from 'react';
import { getAvatarSrc } from '../../utils/avatarUtils';
import {
  characterAvatarFor, paperAvatarFor, gradientFor, initialsFor, AvatarKind,
} from '../utils/avatars';

export type V2AvatarSize = 'sm' | 'md' | 'lg';

interface V2AvatarProps {
  name?: string | null;
  src?: string | null;
  size?: V2AvatarSize;
  className?: string;
  online?: boolean;
  title?: string;
  /**
   * Renders the local identity tier: unpicked humans get Paper, while saved
   * character picks and agents keep the Cut kit. Species stays legible through
   * disjoint background families ('human' warm, 'agent' cool) and dress
   * (agents in ink with a cobalt collar). Omitted → gradient+initials, unchanged
   * — callers that cannot tell who they are drawing must not guess, because
   * mislabelling the tier mislabels the PERSON's species tint. A loadable
   * uploaded photo wins over both tiers; failed human images fall back to Paper.
   */
  kind?: AvatarKind;
  /**
   * Stable identity for the character seed — `agentName:instanceId` or a
   * userId — so a display-name change never changes the face. Falls back to
   * `name` when absent.
   */
  seed?: string | null;
  /**
   * `flat` keeps the transcript's compact square frame. Photos and Big Smile
   * characters retain their identity in this frame; initials are only the
   * fallback when the kind is unknown or character generation fails.
   */
  tone?: 'flat';
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
  name, src, size = 'md', className, online, title, kind, seed: seedProp, tone,
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
  const flat = tone === 'flat';
  const classes = [
    sizeClass(size),
    flat ? `v2-avatar--flat v2-avatar--flat-${kind === 'agent' ? 'agent' : 'human'}` : null,
    className,
  ].filter(Boolean).join(' ');

  // Default identity tier, used when no image is currently renderable. Human
  // images and saved Cut picks use the image path above; if an image fails, an
  // unpicked human falls back to Paper. Agents keep their existing face.
  // Memoized because SVG generation runs per identity per render otherwise,
  // and chat re-renders per message.
  const characterSrc = React.useMemo(
    () => {
      if (!kind) return null;
      if (kind === 'human') return paperAvatarFor(seedProp || seed);
      return characterAvatarFor(seedProp || seed, kind);
    },
    [kind, seedProp, seed],
  );

  React.useEffect(() => {
    setImgFailed(false);
  }, [cleanSrc]);

  if (cleanSrc && !imgFailed) {
    return (
      <span
        className={classes}
        style={{ background: bg }}
        title={display}
      >
        <img
          src={cleanSrc}
          alt={display || 'avatar'}
          onError={() => setImgFailed(true)}
          style={{
            width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit',
          }}
        />
        {online && <span className="v2-avatar__online" />}
      </span>
    );
  }

  if (characterSrc) {
    return (
      <span
        className={classes}
        style={{ background: bg }}
        title={display}
      >
        <img
          src={characterSrc}
          alt={display || 'avatar'}
          style={{
            width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit',
          }}
        />
        {online && <span className="v2-avatar__online" />}
      </span>
    );
  }

  return (
    <span
      className={classes}
      style={flat ? undefined : { background: bg }}
      title={display}
    >
      {initials}
      {online && <span className="v2-avatar__online" />}
    </span>
  );
};

export default V2Avatar;
