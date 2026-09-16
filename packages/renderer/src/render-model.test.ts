import { describe, expect, it } from 'vitest';

import { stubMeasurer } from '../test/helpers/measurer.js';
import { LYRIC, lyricBox, songModel } from '../test/helpers/model.js';
import {
  DEFAULT_ASPECT_RATIO,
  DEFAULT_SAFE_AREA,
  PROVISIONAL_MINIMUM_READABLE_HEIGHT_RATIO,
  administrativeDefaults,
  canvasFor,
  safeAreaOf,
} from './output-profile.js';
import { RenderModelError, isPreparedTextBox, prepareRenderModel } from './render-model.js';
import { renderPrepared } from './renderer.js';
import { RENDER_SURFACES, renderForSurface } from './surfaces.js';

const prepare = async (options: Parameters<typeof prepareRenderModel>[0]) => prepareRenderModel(options);

/** The one text box a single-box fixture prepares to, narrowed so a test can read its size. */
const textBoxOf = (prepared: Awaited<ReturnType<typeof prepareRenderModel>>) => {
  const box = prepared.slides[0]?.boxes[0];
  if (box === undefined || !isPreparedTextBox(box)) throw new Error('the fixture prepared no text box');
  return box;
};

const cramped = () =>
  lyricBox({ frame: { x: 0.1, y: 0.4, width: 0.4, height: 0.08 } });

describe('aspect ratio and safe area are inputs, frozen at preparation', () => {
  it('takes the administrative 16:9 default and the 5% safe area when nothing overrides them', async () => {
    const prepared = await prepare({ model: songModel(), measurer: stubMeasurer() });

    expect(prepared.profile.aspectRatio).toEqual(DEFAULT_ASPECT_RATIO);
    expect(prepared.profile.aspectRatio).toEqual({ width: 16, height: 9 });
    expect(prepared.profile.safeArea).toEqual(DEFAULT_SAFE_AREA);
    expect(prepared.profile.safeArea).toEqual({ top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 });
    expect(prepared.canvas).toEqual({ width: 1920, height: 1080 });
  });

  it('lets a service override the ratio and the margins', async () => {
    const prepared = await prepare({
      model: songModel(),
      measurer: stubMeasurer(),
      service: { aspectRatio: { width: 4, height: 3 }, safeArea: { top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 } },
    });

    expect(prepared.profile.aspectRatio).toEqual({ width: 4, height: 3 });
    expect(prepared.canvas).toEqual({ width: 1920, height: 1440 });
    expect(prepared.safeAreaPx).toEqual({ x: 192, y: 144, width: 1536, height: 1152 });
  });

  it('refuses an item or slide that tries to carry a ratio of its own', async () => {
    const model = songModel();
    const slide = { ...model.slides[0], aspectRatio: { width: 1, height: 1 } };

    await expect(
      prepare({ model: { ...model, slides: [slide] }, measurer: stubMeasurer() } as never),
    ).rejects.toBeInstanceOf(RenderModelError);
  });

  it('refuses a box that tries to carry a ratio of its own', async () => {
    const model = songModel([{ ...lyricBox(), aspectRatio: { width: 1, height: 1 } } as never]);

    await expect(prepare({ model, measurer: stubMeasurer() })).rejects.toThrow(/box lyric on slide slide-1/u);
  });

  // Freezing is a promise this package makes about the model it returns, not a licence to freeze the
  // caller's own objects on the way past.
  it('freezes its own copy of a font spec and leaves the caller’s object alone', async () => {
    const font = { family: 'Inter', weight: 600, sizeRatio: 0.09, lineHeight: 1.2 };
    const prepared = await prepare({ model: songModel([lyricBox({ font })]), measurer: stubMeasurer() });

    expect(Object.isFrozen(font)).toBe(false);
    expect(Object.isFrozen(textBoxOf(prepared).font)).toBe(true);
    expect(textBoxOf(prepared).font).toEqual(font);
    expect(textBoxOf(prepared).font).not.toBe(font);
  });

  it('freezes the resolved profile so nothing re-resolves it mid-render', async () => {
    const prepared = await prepare({ model: songModel(), measurer: stubMeasurer() });

    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.profile)).toBe(true);
    expect(Object.isFrozen(prepared.profile.safeArea)).toBe(true);
    expect(() => {
      (prepared.profile as { aspectRatio: unknown }).aspectRatio = { width: 1, height: 1 };
    }).toThrow(TypeError);
  });

  // The point of the split between preparation and rendering: rendering may not reach for a default. A
  // model prepared against numbers that are nothing like the module's must come out of every surface
  // carrying its own numbers, so a rendering step that quietly re-resolved the defaults would be caught
  // here rather than the next time somebody overrode a ratio.
  it('renders the ratio, canvas, safe area and floor it was prepared with, not the module defaults', async () => {
    const service = {
      aspectRatio: { width: 4, height: 3 },
      safeArea: safeAreaOf(0.1),
      minimumReadableHeightRatio: 0.08,
    };
    const prepared = await prepare({ model: songModel(), measurer: stubMeasurer(), service });
    const frame = renderPrepared(prepared);

    expect(frame.aspectRatio).toEqual({ width: 4, height: 3 });
    expect(frame.aspectRatio).not.toEqual(DEFAULT_ASPECT_RATIO);
    expect(frame.canvas).toEqual({ width: 1920, height: 1440 });
    expect(frame.canvas).not.toEqual(canvasFor(DEFAULT_ASPECT_RATIO));
    expect(frame.safeArea).toEqual({ x: 192, y: 144, width: 1536, height: 1152 });
    expect(frame.safeArea).not.toEqual({ x: 96, y: 54, width: 1728, height: 972 });
    expect(frame.minimumFontSizePx).toBe(0.08 * 1440);
    expect(frame.minimumFontSizePx).not.toBe(PROVISIONAL_MINIMUM_READABLE_HEIGHT_RATIO * 1080);

    for (const surface of RENDER_SURFACES) {
      const surfaceFrame = renderForSurface(surface, prepared).frame;
      expect(surfaceFrame.aspectRatio).toEqual({ width: 4, height: 3 });
      expect(surfaceFrame.canvas).toEqual({ width: 1920, height: 1440 });
      expect(surfaceFrame.safeArea).toEqual(frame.safeArea);
      expect(surfaceFrame.minimumFontSizePx).toBe(0.08 * 1440);
    }
  });

  it('keeps the values it was prepared with when the defaults change afterwards', async () => {
    const defaults = {
      ...administrativeDefaults,
      aspectRatio: { width: 16, height: 9 },
      byOutputType: { ...administrativeDefaults.byOutputType },
    };
    const prepared = await prepare({ model: songModel(), measurer: stubMeasurer(), defaults });

    defaults.aspectRatio = { width: 1, height: 1 };

    expect(prepared.profile.aspectRatio).toEqual({ width: 16, height: 9 });
    expect(renderPrepared(prepared).aspectRatio).toEqual({ width: 16, height: 9 });
  });
});

describe('the minimum readable size is a floor, not a suggestion', () => {
  it('blocks readiness instead of rendering text below the effective minimum', async () => {
    const prepared = await prepare({ model: songModel([cramped()]), measurer: stubMeasurer() });
    const frame = renderPrepared(prepared);
    const floor = PROVISIONAL_MINIMUM_READABLE_HEIGHT_RATIO * 1080;

    expect(prepared.minimumFontSizePx).toBe(floor);
    expect(frame.slides[0]?.boxes[0]?.fontSizePx).toBe(floor);
    expect(frame.slides[0]?.boxes[0]?.text).toBe(LYRIC);
    expect(frame.findings).toContainEqual(
      expect.objectContaining({
        code: 'text.overflowsAtMinimumReadableSize',
        severity: 'blocker',
        boxId: 'lyric',
      }),
    );
    expect(frame.readiness).toBe('blocked');
  });

  it('blocks rather than honouring a layout that asks for text below the floor', async () => {
    const prepared = await prepare({
      model: songModel([lyricBox({ font: { family: 'Inter', weight: 600, sizeRatio: 0.01, lineHeight: 1.2 } })]),
      measurer: stubMeasurer(),
    });

    expect(textBoxOf(prepared).fontSizePx).toBe(PROVISIONAL_MINIMUM_READABLE_HEIGHT_RATIO * 1080);
    expect(prepared.findings).toContainEqual(
      expect.objectContaining({ code: 'text.belowMinimumReadableSize', severity: 'blocker' }),
    );
  });

  it('walks the ladder at the step a caller asked for', async () => {
    const measurer = stubMeasurer();
    await prepare({ model: songModel(), measurer, stepPx: 8 });
    const sizes = measurer.seen.map((entry) => entry.fontSizePx);

    expect(sizes[0]).toBe(97.2);
    expect(sizes[1]).toBe(89.2);
    expect(sizes.at(-1)).toBe(43.2);
  });

  it('measures every slide in one trip to the layout engine', async () => {
    const measurer = stubMeasurer();
    await prepare({
      model: {
        id: 'set-1',
        outputType: 'main',
        slides: [
          { id: 'slide-1', boxes: [lyricBox()] },
          { id: 'slide-2', boxes: [lyricBox({ id: 'second', text: 'Amen' })] },
        ],
      },
      measurer,
    });

    expect(measurer.batches).toHaveLength(1);
    expect(measurer.seen.some((entry) => entry.text === 'Amen')).toBe(true);
  });

  it('lets a Slide Layout text box raise the floor but never lower it', async () => {
    const raised = await prepare({
      model: songModel([lyricBox({ minimumReadableHeightRatio: 0.1 })]),
      measurer: stubMeasurer(),
    });
    const lowered = await prepare({
      model: songModel([lyricBox({ minimumReadableHeightRatio: 0.01 })]),
      measurer: stubMeasurer(),
    });

    expect(textBoxOf(raised).minimumFontSizePx).toBe(108);
    expect(textBoxOf(lowered).minimumFontSizePx).toBe(PROVISIONAL_MINIMUM_READABLE_HEIGHT_RATIO * 1080);
  });
});
