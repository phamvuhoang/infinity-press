// Pure geometry for the home hero crop. The admin picks one focal point and one zoom; each output
// aspect derives its own rectangle from them, so the desktop and phone renditions stay centred on
// the same part of the photograph.

export type CropRect = { x: number; y: number; width: number; height: number };

export const HERO_MIN_ZOOM = 1;
export const HERO_MAX_ZOOM = 3;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// At zoom 1 the rectangle is the largest one of `aspect` that fits inside the source. Zooming
// shrinks it around the focal point, which is expressed in 0..1 of the source and clamped so the
// rectangle never leaves the image.
export function heroCropRect(
  sourceWidth: number,
  sourceHeight: number,
  aspect: number,
  zoom: number,
  focalX: number,
  focalY: number,
): CropRect {
  const safeZoom = clamp(zoom, HERO_MIN_ZOOM, HERO_MAX_ZOOM);
  const fitWidth = Math.min(sourceWidth, sourceHeight * aspect);
  const width = fitWidth / safeZoom;
  const height = width / aspect;

  const centerX = clamp(focalX, 0, 1) * sourceWidth;
  const centerY = clamp(focalY, 0, 1) * sourceHeight;

  return {
    x: clamp(centerX - width / 2, 0, sourceWidth - width),
    y: clamp(centerY - height / 2, 0, sourceHeight - height),
    width,
    height,
  };
}
