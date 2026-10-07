import React, {
  useEffect, useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  createAvatarCropBlob, CropCenter, imageDrawRectForCrop, squareCropRectFor,
} from '../utils/avatarCrop';

interface V2AvatarCropDialogProps {
  file: File;
  saving: boolean;
  error: string | null;
  returnFocusElement?: HTMLElement | null;
  onCancel: () => void;
  onSave: (image: Blob) => void;
}

const STAGE_WIDTH = 392;
const STAGE_HEIGHT = 260;
const FRAME_SIZE = STAGE_HEIGHT * 0.58;
const PREVIEW_SIZE = 64;
const OUTPUT_SIZE = 512;

const centerOf = (image: HTMLImageElement): CropCenter => ({
  x: image.naturalWidth / 2,
  y: image.naturalHeight / 2,
});

const V2AvatarCropDialog: React.FC<V2AvatarCropDialogProps> = ({
  file, saving, error, onCancel, onSave,
  returnFocusElement,
}) => {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [center, setCenter] = useState<CropCenter | null>(null);
  const [zoom, setZoom] = useState(1);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setImage(null);
    setCenter(null);
    setPreviewSrc(null);
    setLoadError(null);
    const objectUrl = URL.createObjectURL(file);
    const nextImage = new Image();
    nextImage.onload = () => {
      if (!active) return;
      setImage(nextImage);
      setCenter(centerOf(nextImage));
      setZoom(1);
      setLoadError(null);
    };
    nextImage.onerror = () => {
      if (active) setLoadError(t('settings.avatar.imageCouldNotLoad'));
    };
    nextImage.src = objectUrl;

    return () => {
      active = false;
      nextImage.onload = null;
      nextImage.onerror = null;
      URL.revokeObjectURL(objectUrl);
    };
  }, [file, t]);

  useEffect(() => {
    if (!image || !center) return;
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    const crop = squareCropRectFor(image.naturalWidth, image.naturalHeight, zoom, center);
    const imageRect = crop && imageDrawRectForCrop(
      image.naturalWidth,
      image.naturalHeight,
      crop,
      STAGE_WIDTH,
      STAGE_HEIGHT,
      FRAME_SIZE,
    );
    if (!canvas || !context || !crop || !imageRect) return;

    canvas.width = STAGE_WIDTH;
    canvas.height = STAGE_HEIGHT;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.clearRect(0, 0, STAGE_WIDTH, STAGE_HEIGHT);
    context.drawImage(image, imageRect.x, imageRect.y, imageRect.width, imageRect.height);

    const previewCanvas = previewCanvasRef.current || document.createElement('canvas');
    previewCanvasRef.current = previewCanvas;
    previewCanvas.width = PREVIEW_SIZE;
    previewCanvas.height = PREVIEW_SIZE;
    const previewContext = previewCanvas.getContext('2d');
    if (!previewContext) return;
    previewContext.imageSmoothingEnabled = true;
    previewContext.imageSmoothingQuality = 'high';
    previewContext.drawImage(
      image,
      crop.x,
      crop.y,
      crop.side,
      crop.side,
      0,
      0,
      PREVIEW_SIZE,
      PREVIEW_SIZE,
    );
    try {
      setPreviewSrc(previewCanvas.toDataURL('image/png'));
    } catch {
      setPreviewSrc(null);
    }
  }, [center, image, zoom]);

  useEffect(() => {
    const previousFocus = returnFocusElement
      || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    cancelButtonRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [returnFocusElement]);

  const handleDialogKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      if (!saving) onCancel();
      event.preventDefault();
      // App.tsx's setupFocusManagement blurs the active element on any Escape that reaches document.
      event.stopPropagation();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (!focusable?.length) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const beginDrag = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!image || !center || saving) return;
    event.preventDefault();
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };

  const moveCrop = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !image) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const crop = squareCropRectFor(image.naturalWidth, image.naturalHeight, zoom, center || centerOf(image));
    if (!crop || bounds.width <= 0 || bounds.height <= 0) return;

    const frameScreenSide = bounds.width * FRAME_SIZE / STAGE_WIDTH;
    if (frameScreenSide <= 0) return;
    const dx = (event.clientX - drag.x) * crop.side / frameScreenSide;
    const dy = (event.clientY - drag.y) * crop.side / frameScreenSide;
    const currentCenter = { x: crop.x + crop.side / 2, y: crop.y + crop.side / 2 };
    const nextCrop = squareCropRectFor(image.naturalWidth, image.naturalHeight, zoom, {
      x: currentCenter.x - dx,
      y: currentCenter.y - dy,
    });
    if (nextCrop) setCenter({ x: nextCrop.x + nextCrop.side / 2, y: nextCrop.y + nextCrop.side / 2 });
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  };

  const endDrag = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (typeof event.currentTarget.releasePointerCapture === 'function'
      && event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const moveCropWithKeyboard = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (!image || !center || saving) return;
    const directions: Record<string, CropCenter> = {
      ArrowUp: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 },
      ArrowLeft: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 },
    };
    const direction = directions[event.key];
    if (!direction) return;
    event.preventDefault();
    const crop = squareCropRectFor(image.naturalWidth, image.naturalHeight, zoom, center);
    if (!crop) return;
    const step = Math.max(1, crop.side * (event.shiftKey ? 0.05 : 0.01));
    const nextCrop = squareCropRectFor(image.naturalWidth, image.naturalHeight, zoom, {
      x: center.x + direction.x * step,
      y: center.y + direction.y * step,
    });
    if (nextCrop) setCenter({ x: nextCrop.x + nextCrop.side / 2, y: nextCrop.y + nextCrop.side / 2 });
  };

  const save = async () => {
    if (!image || !center || saving) return;
    const crop = squareCropRectFor(image.naturalWidth, image.naturalHeight, zoom, center);
    if (!crop) return;
    try {
      const blob = await createAvatarCropBlob(image, crop, OUTPUT_SIZE);
      onSave(blob);
    } catch {
      setLoadError(t('settings.avatar.cropCouldNotSave'));
    }
  };

  const minimumZoom = 1;
  const zoomRange = Math.max(0.00001, 3 - minimumZoom);
  const zoomProgress = `${Math.max(0, Math.min(100, ((zoom - minimumZoom) / zoomRange) * 100))}%`;

  return createPortal((
    <div
      className="v2-root v2-modal__overlay v2-settings__avatar-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !saving) onCancel();
      }}
    >
      <section
        ref={dialogRef}
        className="v2-modal v2-settings__avatar-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="v2-settings-avatar-dialog-title"
        aria-describedby="v2-settings-avatar-dialog-description"
        onKeyDown={handleDialogKeyDown}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="v2-modal__head">
          <h2 className="v2-modal__title" id="v2-settings-avatar-dialog-title">
            {t('settings.avatar.uploadTitle')}
          </h2>
          <button
            type="button"
            className="v2-modal__close"
            aria-label={t('common.close')}
            onClick={() => { if (!saving) onCancel(); }}
            disabled={saving}
          >
            ×
          </button>
        </div>
        <div className="v2-modal__body">
          <div className="v2-settings__avatar-crop-stage">
            <canvas
              ref={canvasRef}
              className="v2-settings__avatar-crop"
              width={STAGE_WIDTH}
              height={STAGE_HEIGHT}
              aria-label={t('settings.avatar.cropPreview')}
              aria-describedby="v2-settings-avatar-dialog-description"
              onPointerDown={beginDrag}
              onPointerMove={moveCrop}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              tabIndex={0}
              onKeyDown={moveCropWithKeyboard}
            />
            <div className="v2-settings__avatar-crop-dim" aria-hidden="true">
              <span className="v2-settings__avatar-crop-dim-top" />
              <span className="v2-settings__avatar-crop-dim-right" />
              <span className="v2-settings__avatar-crop-dim-bottom" />
              <span className="v2-settings__avatar-crop-dim-left" />
            </div>
            <div className="v2-settings__avatar-crop-frame" aria-hidden="true" />
          </div>
          {!image && !loadError && (
            <p className="v2-settings__avatar-crop-loading" role="status">{t('settings.avatar.loadingImage')}</p>
          )}
          <label className="v2-settings__avatar-zoom" style={{ '--avatar-zoom-progress': zoomProgress } as React.CSSProperties}>
            <span>{t('settings.avatar.zoom')}</span>
            <input
              type="range"
              min={minimumZoom}
              max="3"
              step="0.1"
              value={zoom}
              aria-label={t('settings.avatar.zoom')}
              onChange={(event) => {
                setZoom(Number(event.target.value));
              }}
              disabled={!image || saving}
            />
          </label>
          <p className="v2-modal__hint" id="v2-settings-avatar-dialog-description">
            {t('settings.avatar.cropInstructions')}
          </p>
          <div className="v2-settings__avatar-footer">
            <div className="v2-settings__avatar-previews" role="group" aria-label={t('settings.avatar.previewSizes')}>
              {[64, 32, 22].map((size) => (
                <div className="v2-settings__avatar-preview" key={size}>
                  <span>{t('settings.avatar.previewAt', { size })}</span>
                  {previewSrc && <img src={previewSrc} alt="" className={`v2-settings__avatar-preview-image v2-settings__avatar-preview-image--${size}`} />}
                </div>
              ))}
            </div>
            <div className="v2-settings__avatar-dialog-actions">
              <button ref={cancelButtonRef} type="button" className="v2-settings__secondary" onClick={onCancel} disabled={saving}>
                {t('settings.avatar.cancel')}
              </button>
              <button type="button" className="v2-settings__primary" onClick={() => void save()} disabled={!image} aria-disabled={saving}>
                {saving ? t('settings.avatar.savingPhoto') : t('settings.avatar.savePhoto')}
              </button>
            </div>
          </div>
          {(error || loadError) && (
            <p className="v2-modal__error" role="alert">{error || loadError}</p>
          )}
        </div>
      </section>
    </div>
  ), document.body);
};

export default V2AvatarCropDialog;
