import React from 'react';
import { colorFor, initialsFor } from '../utils/avatars';

export type V2AvatarSize = 'sm' | 'md' | 'lg';

interface V2AvatarProps {
  name?: string | null;
  src?: string | null;
  size?: V2AvatarSize;
  online?: boolean;
  title?: string;
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

const V2Avatar: React.FC<V2AvatarProps> = ({ name, src, size = 'md', online, title }) => {
  const seed = String(name || '');
  const bg = colorFor(seed);
  const initials = initialsFor(seed);
  const display = title || seed || undefined;
  const cleanSrc = typeof src === 'string' && src.trim().length > 0 ? src.trim() : null;
  const [imgFailed, setImgFailed] = React.useState(false);

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
