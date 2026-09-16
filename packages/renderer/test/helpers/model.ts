// One song slide, spelled out once, so four suites argue about the same input rather than four
// near-identical ones. Everything is normalized: frames are fractions of the canvas and the font size is
// a fraction of the canvas height, which is what lets the same model drive a 320px thumbnail and a 4K
// output view without a second set of numbers.

import type { RenderModelInput, TextBox } from '../../src/render-model.js';

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

export const songModel = (boxes: readonly TextBox[] = [lyricBox()]): RenderModelInput => ({
  id: 'set-1',
  outputType: 'main',
  slides: [{ id: 'slide-1', boxes }],
});
