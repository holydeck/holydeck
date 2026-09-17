// One song slide, spelled out once, so four suites argue about the same input rather than four
// near-identical ones. Everything is normalized: frames are fractions of the canvas and the font size is
// a fraction of the canvas height, which is what lets the same model drive a 320px thumbnail and a 4K
// output view without a second set of numbers.

import type { MediaBox, RenderModelInput, SlideBox, TextBox } from '../../src/render-model.js';

export const LYRIC =
  'Praise to the Lord the Almighty the King of creation O my soul praise Him for He is thy health and salvation';

export const lyricBox = (overrides: Partial<TextBox> = {}): TextBox => ({
  id: 'lyric',
  kind: 'text',
  text: LYRIC,
  frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.5 },
  font: { family: 'Inter', weight: 600, sizeRatio: 0.09, lineHeight: 1.2 },
  importance: 'required',
  ...overrides,
});

export const songModel = (boxes: readonly SlideBox[] = [lyricBox()]): RenderModelInput => ({
  id: 'set-1',
  outputType: 'main',
  slides: [{ id: 'slide-1', boxes }],
});

/**
 * A media box on the same slide, inside the safe area, so a suite arguing about fit modes or audio is not
 * also arguing about the safe area. The frame is 192,216 768x432 on the reference canvas — every fit mode
 * lands on a whole pixel from it, which is what lets the geometry be asserted rather than approximated.
 */
export const MEDIA_FRAME_PX = { x: 192, y: 216, width: 768, height: 432 } as const;

export const mediaBox = (overrides: Partial<MediaBox> = {}): MediaBox => ({
  id: 'still',
  kind: 'media',
  mediaKind: 'image',
  frame: { x: 0.1, y: 0.2, width: 0.4, height: 0.4 },
  fit: 'contain',
  importance: 'required',
  intrinsicSize: { width: 1600, height: 400 },
  ...overrides,
});
