import {
  imageDrawRectForCrop, minimumZoomToCoverStage, squareCropRectFor,
} from '../utils/avatarCrop';

describe('squareCropRectFor', () => {
  test('starts centered and makes a square from a landscape image', () => {
    expect(squareCropRectFor(1600, 900, 1)).toEqual({ x: 350, y: 0, side: 900 });
  });

  test('zooms around the selected center and clamps the crop inside the image', () => {
    expect(squareCropRectFor(1200, 800, 2, { x: 0, y: 800 })).toEqual({
      x: 0, y: 400, side: 400,
    });
  });

  test('bounds zoom to the supported range and rejects invalid image dimensions', () => {
    expect(squareCropRectFor(640, 480, 20)?.side).toBe(480 / 3);
    expect(squareCropRectFor(0, 480, 1)).toBeNull();
    expect(squareCropRectFor(640, Number.NaN, 1)).toBeNull();
  });

  test('opens at the smallest zoom that fills the landscape stage behind the square window', () => {
    const zoom = minimumZoomToCoverStage(1600, 900, 392, 260, 150.8);
    const crop = squareCropRectFor(1600, 900, zoom);
    expect(zoom).toBeCloseTo(260 / 150.8);
    expect(crop?.side).toBeCloseTo(522);
  });

  test('positions the full source image behind the fixed crop frame', () => {
    const zoom = minimumZoomToCoverStage(1600, 900, 392, 260, 150.8);
    const crop = squareCropRectFor(1600, 900, zoom);
    expect(crop).not.toBeNull();
    const imageRect = imageDrawRectForCrop(1600, 900, crop as NonNullable<typeof crop>, 392, 260, 150.8);
    expect(imageRect?.x).toBeCloseTo((392 - 150.8) / 2 - (539 * 260) / 900);
    expect(imageRect?.y).toBeCloseTo(0);
    expect(imageRect?.width).toBeCloseTo((1600 * 260) / 900);
    expect(imageRect?.height).toBeCloseTo(260);
  });
});
