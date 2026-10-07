export interface CropCenter {
  x: number;
  y: number;
}

export interface SquareCropRect {
  x: number;
  y: number;
  side: number;
}

export interface ImageDrawRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

/** Return a square source-image crop, clamped so no empty edge can be saved. */
export const squareCropRectFor = (
  imageWidth: number,
  imageHeight: number,
  zoom: number,
  center: CropCenter = { x: imageWidth / 2, y: imageHeight / 2 },
): SquareCropRect | null => {
  if (![imageWidth, imageHeight, zoom, center.x, center.y].every(Number.isFinite)
    || imageWidth <= 0 || imageHeight <= 0) return null;

  const boundedZoom = clamp(zoom, 1, 3);
  const side = Math.min(imageWidth, imageHeight) / boundedZoom;
  const x = clamp(center.x, side / 2, imageWidth - side / 2) - side / 2;
  const y = clamp(center.y, side / 2, imageHeight - side / 2) - side / 2;
  return { x, y, side };
};

/** Place the full image behind a fixed square crop window on the preview stage. */
export const imageDrawRectForCrop = (
  imageWidth: number,
  imageHeight: number,
  crop: SquareCropRect,
  stageWidth = 392,
  stageHeight = 260,
  frameSize = 150.8,
): ImageDrawRect | null => {
  if (![imageWidth, imageHeight, crop.x, crop.y, crop.side, stageWidth, stageHeight, frameSize].every(Number.isFinite)
    || imageWidth <= 0 || imageHeight <= 0 || crop.side <= 0
    || stageWidth <= 0 || stageHeight <= 0 || frameSize <= 0) return null;

  const scale = frameSize / crop.side;
  const insetX = (stageWidth - frameSize) / 2;
  const insetY = (stageHeight - frameSize) / 2;
  return {
    x: insetX - crop.x * scale,
    y: insetY - crop.y * scale,
    width: imageWidth * scale,
    height: imageHeight * scale,
  };
};

/** Convert the selected square to a 512px PNG for the profile-picture upload. */
export const createAvatarCropBlob = (
  image: CanvasImageSource,
  rect: SquareCropRect,
  outputSize = 512,
): Promise<Blob> => new Promise((resolve, reject) => {
  const canvas = document.createElement('canvas');
  canvas.width = outputSize;
  canvas.height = outputSize;
  const context = canvas.getContext('2d');
  if (!context) {
    reject(new Error('Could not prepare the image crop.'));
    return;
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, rect.x, rect.y, rect.side, rect.side, 0, 0, outputSize, outputSize);
  canvas.toBlob((blob) => {
    if (blob) resolve(blob);
    else reject(new Error('Could not encode the image crop.'));
  }, 'image/png');
});
