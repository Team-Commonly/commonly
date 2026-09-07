import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getSignedAttachmentUrl } from '../../utils/signedAttachmentUrl';

export interface V2LightboxImage {
  src: string;
  name: string;
}

interface V2LightboxProps {
  images: V2LightboxImage[];
  index: number;
  onClose: () => void;
}

/**
 * Direction C lightbox: ink ground at 90%, the image contained, the filename
 * top-left, a 28px close square top-right, ←/→ across the images of the same
 * message, Esc closes. Rendered by the message row that owns the thumbnails.
 */
const V2Lightbox: React.FC<V2LightboxProps> = ({ images, index, onClose }) => {
  const { t } = useTranslation();
  const [current, setCurrent] = useState(index);
  const count = images.length;
  const image = images[Math.min(current, count - 1)];

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key === 'ArrowRight' && count > 1) setCurrent((i) => (i + 1) % count);
      if (event.key === 'ArrowLeft' && count > 1) setCurrent((i) => (i - 1 + count) % count);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [count, onClose]);

  // Same signed-URL bridge as the thumbnails: the full image needs it too.
  const [resolved, setResolved] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setResolved(null);
    if (!image || !/\/api\/uploads\//.test(image.src)) return undefined;
    void getSignedAttachmentUrl(image.src).then((signed) => { if (active && signed) setResolved(signed); });
    return () => { active = false; };
  }, [image]);

  if (!image) return null;

  return (
    <div className="v2-lightbox" role="dialog" aria-modal="true" aria-label={image.name} onClick={onClose}>
      <span className="v2-lightbox__name">{image.name}{count > 1 ? ` · ${current + 1}/${count}` : ''}</span>
      <button type="button" className="v2-lightbox__close" aria-label={t('podChat.lightbox.close')} onClick={onClose}>×</button>
      {count > 1 && (
        <>
          <button type="button" className="v2-lightbox__nav v2-lightbox__nav--prev" aria-label={t('podChat.lightbox.previous')} onClick={(event) => { event.stopPropagation(); setCurrent((i) => (i - 1 + count) % count); }}>←</button>
          <button type="button" className="v2-lightbox__nav v2-lightbox__nav--next" aria-label={t('podChat.lightbox.next')} onClick={(event) => { event.stopPropagation(); setCurrent((i) => (i + 1) % count); }}>→</button>
        </>
      )}
      <img className="v2-lightbox__image" src={resolved || image.src} alt={image.name} onClick={(event) => event.stopPropagation()} />
    </div>
  );
};

export default V2Lightbox;
