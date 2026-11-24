import { Image, Skia, createPicture, usePictureAsTexture, type SkPicture } from '@shopify/react-native-skia';
import { useMemo } from 'react';
import { PixelRatio } from 'react-native';

const DPR = Math.min(3, PixelRatio.get());

type Bounds = { x: number; y: number; width: number; height: number };

/**
 * Rasterises a picture recorded in points once, at device resolution, into a texture on the UI
 * thread. Static art that would otherwise be replayed every frame (gold lettering drawn as
 * outlined paths, blurred glows) then costs one image draw: Ganesh no longer rebuilds the glyph
 * coverage masks on the CPU each frame.
 */
export function useBakedPicture(picture: SkPicture, b: Bounds) {
  const { x, y, width, height } = b;
  const scaled = useMemo(
    () =>
      createPicture((canvas) => {
        canvas.scale(DPR, DPR);
        canvas.translate(-x, -y);
        canvas.drawPicture(picture);
      }, Skia.XYWHRect(0, 0, width * DPR, height * DPR)),
    [picture, x, y, width, height],
  );
  const size = useMemo(() => ({ width: Math.ceil(width * DPR), height: Math.ceil(height * DPR) }), [width, height]);
  return usePictureAsTexture(scaled, size);
}

/** A static picture drawn as a pre-rendered texture (see `useBakedPicture`). */
export function BakedPicture({ picture, bounds }: { picture: SkPicture; bounds: Bounds }) {
  const tex = useBakedPicture(picture, bounds);
  return <Image image={tex} x={bounds.x} y={bounds.y} width={bounds.width} height={bounds.height} fit="fill" />;
}
