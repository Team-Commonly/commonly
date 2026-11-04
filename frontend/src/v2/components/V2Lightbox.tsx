import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getSignedAttachmentUrl } from '../../utils/signedAttachmentUrl';
import { messageImageUrl } from '../utils/messageImageUrl';
import { ShellGlyph } from '../icons/glyphs';

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

  // Same signed-URL bridge as the thumbnails: the full image needs it too. An
  // upload renders only from its signed URL. The raw `/api/uploads/...` path is
  // relative to the app's origin, not the API's, and uploads need a token, so
  // drawing it while the mint is in flight (or after it failed) requested a 404
  // and flashed a broken image (D215 crawl, 2026-11-04).
  const [resolved, setResolved] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const isUpload = Boolean(image && /\/api\/uploads\//.test(image.src));
  useEffect(() => {
    let active = true;
    setResolved(null);
    setFailed(false);
    if (!image || !/\/api\/uploads\//.test(image.src)) return undefined;
    getSignedAttachmentUrl(image.src).then((signed) => {
      if (!active) return;
      const safeSigned = messageImageUrl(signed);
      if (safeSigned) setResolved(safeSigned);
      else setFailed(true);
    }).catch(() => {
      // A mint that throws (offline, CORS, a dropped connection) is a failure
      // too, not a blank overlay.
      if (active) setFailed(true);
    });
    return () => { active = false; };
    // Keyed on the src: callers pass a fresh image object on every render, and
    // re-minting on each one blanked the image.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image?.src]);

  if (!image) return null;

  return (
    <div className="v2-lightbox" role="dialog" aria-modal="true" aria-label={image.name} onClick={onClose}>
      <span className="v2-lightbox__name">{image.name}{count > 1 ? ` · ${current + 1}/${count}` : ''}</span>
      <button type="button" className="v2-lightbox__close" aria-label={t('podChat.lightbox.close')} onClick={onClose}><ShellGlyph name="close" /></button>
      {count > 1 && (
        <>
          <button type="button" className="v2-lightbox__nav v2-lightbox__nav--prev" aria-label={t('podChat.lightbox.previous')} onClick={(event) => { event.stopPropagation(); setCurrent((i) => (i - 1 + count) % count); }}><ShellGlyph name="chevron-left" /></button>
          <button type="button" className="v2-lightbox__nav v2-lightbox__nav--next" aria-label={t('podChat.lightbox.next')} onClick={(event) => { event.stopPropagation(); setCurrent((i) => (i + 1) % count); }}><ShellGlyph name="chevron-right" /></button>
        </>
      )}
      {(() => {
        const src = isUpload ? resolved : messageImageUrl(image.src);
        if (src) return <img className="v2-lightbox__image" src={src} alt={image.name} onClick={(event) => event.stopPropagation()} />;
        if (failed) return <p className="v2-lightbox__failed">{t('podChat.lightbox.failed')}</p>;
        return null;
      })()}
    </div>
  );
};

export default V2Lightbox;
