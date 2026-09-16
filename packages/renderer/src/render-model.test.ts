import { describe, expect, it } from 'vitest';

import { stubMeasurer } from '../test/helpers/measurer.js';
import { LYRIC, lyricBox, songModel } from '../test/helpers/model.js';
import {
  DEFAULT_ASPECT_RATIO,
  DEFAULT_SAFE_AREA,
  PROVISIONAL_MINIMUM_READABLE_HEIGHT_RATIO,
  administrativeDefaults,
} from './output-profile.js';
import { RenderModelError, isPreparedTextBox, prepareRenderModel } from './render-model.js';
import { renderPrepared } from './renderer.js';

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

  it('freezes the resolved profile so nothing re-resolves it mid-render', async () => {
    const prepared = await prepare({ model: songModel(), measurer: stubMeasurer() });

    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.profile)).toBe(true);
    expect(Object.isFrozen(prepared.profile.safeArea)).toBe(true);
    expect(() => {
      (prepared.profile as { aspectRatio: unknown }).aspectRatio = { width: 1, height: 1 };
    }).toThrow(TypeError);
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
