import { describe, expect, it } from 'vitest';

import { stubMeasurer } from '../test/helpers/measurer.js';
import { LYRIC, MEDIA_FRAME_PX, lyricBox, mediaBox, songModel } from '../test/helpers/model.js';
import { isScalableSize, mediaRectFor } from './media-fit.js';
import {
  DEFAULT_ASPECT_RATIO,
  DEFAULT_MAXIMUM_AUDIO_VOLUME,
  DEFAULT_SAFE_AREA,
  PROVISIONAL_MINIMUM_READABLE_HEIGHT_RATIO,
  administrativeDefaults,
  canvasFor,
  safeAreaOf,
} from './output-profile.js';
import {
  MEDIA_FITS,
  MediaGeometryError,
  RenderModelError,
  isPreparedMediaBox,
  isPreparedTextBox,
  prepareRenderModel,
} from './render-model.js';
import { renderPrepared } from './renderer.js';
import { RENDER_SURFACES, renderForSurface } from './surfaces.js';

import type { IntrinsicSize, MediaFit, MediaKind, MediaPlaybackState, MediaRecovery } from './render-model.js';

const prepare = async (options: Parameters<typeof prepareRenderModel>[0]) => prepareRenderModel(options);

/** The one text box a single-box fixture prepares to, narrowed so a test can read its size. */
const textBoxOf = (prepared: Awaited<ReturnType<typeof prepareRenderModel>>) => {
  const box = prepared.slides[0]?.boxes[0];
  if (box === undefined || !isPreparedTextBox(box)) throw new Error('the fixture prepared no text box');
  return box;
};

/** The same, for the box that carries a picture. */
const mediaBoxOf = (prepared: Awaited<ReturnType<typeof prepareRenderModel>>) => {
  const box = prepared.slides[0]?.boxes[0];
  if (box === undefined || !isPreparedMediaBox(box)) throw new Error('the fixture prepared no media box');
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
    expect(prepared.profile.safeArea).toEqual({ unit: 'percent', top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 });
    expect(prepared.canvas).toEqual({ width: 1920, height: 1080 });
  });

  it('lets a service override the ratio and the margins', async () => {
    const prepared = await prepare({
      model: songModel(),
      measurer: stubMeasurer(),
      service: {
        aspectRatio: { width: 4, height: 3 },
        safeArea: { unit: 'percent', top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 },
      },
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

  // Letterboxing is a centred `contain`, so a ratio with a zero side would scale its way into a frame of
  // `NaN` bars. A slide is allowed to carry a layout ratio, but not one with nothing to scale.
  it('refuses a layout aspect ratio with nothing to scale', async () => {
    const model = songModel();
    const slide = { id: 'slide-1', boxes: [lyricBox()], layoutAspectRatio: { width: 0, height: 9 } };

    await expect(
      prepare({ model: { ...model, slides: [slide] }, measurer: stubMeasurer() }),
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

/** Wider than its frame and taller than its frame: the two ways a picture can disagree with its box. */
const WIDER: IntrinsicSize = { width: 1600, height: 400 };
const TALLER: IntrinsicSize = { width: 400, height: 1600 };

/**
 * Hand-computed from the 192,216 768x432 frame rather than derived from the code, so a formula that
 * changed would be caught here instead of being echoed back.
 */
const FITTED: readonly {
  readonly fit: MediaFit;
  readonly intrinsicSize: IntrinsicSize;
  readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}[] = [
  // Intrinsic pixels, centred, spilling out of both ends of a frame narrower than the picture.
  { fit: 'original', intrinsicSize: WIDER, rect: { x: -224, y: 232, width: 1600, height: 400 } },
  { fit: 'original', intrinsicSize: TALLER, rect: { x: 376, y: -368, width: 400, height: 1600 } },
  // Scaled by the smaller of 768/1600 and 432/400, which is 0.48: the whole picture, inside the frame.
  { fit: 'contain', intrinsicSize: WIDER, rect: { x: 192, y: 336, width: 768, height: 192 } },
  { fit: 'contain', intrinsicSize: TALLER, rect: { x: 522, y: 216, width: 108, height: 432 } },
  // Scaled by the larger of the two, which is 1.08: the frame filled, with the picture cropped by it.
  { fit: 'cover', intrinsicSize: WIDER, rect: { x: -288, y: 216, width: 1728, height: 432 } },
  { fit: 'cover', intrinsicSize: TALLER, rect: { x: 192, y: -1104, width: 768, height: 3072 } },
  // The frame itself, proportions abandoned.
  { fit: 'stretch', intrinsicSize: WIDER, rect: { x: 192, y: 216, width: 768, height: 432 } },
  { fit: 'stretch', intrinsicSize: TALLER, rect: { x: 192, y: 216, width: 768, height: 432 } },
];

const MEDIA_KINDS: readonly MediaKind[] = ['image', 'video'];

describe('where a picture lands inside the box that holds it', () => {
  it('has a hand-computed rectangle for every mode the package declares', () => {
    expect([...new Set(FITTED.map((row) => row.fit))]).toEqual([...MEDIA_FITS]);
  });

  for (const mediaKind of MEDIA_KINDS) {
    for (const { fit, intrinsicSize, rect } of FITTED) {
      const shape = intrinsicSize.width > intrinsicSize.height ? 'wider' : 'taller';

      it(`fits a ${shape}-than-its-frame ${mediaKind} with ${fit}`, async () => {
        const prepared = await prepare({
          model: songModel([mediaBox({ mediaKind, fit, intrinsicSize })]),
          measurer: stubMeasurer(),
        });
        const box = mediaBoxOf(prepared);

        expect(box.frame).toEqual(MEDIA_FRAME_PX);
        expect(box.mediaRect).toEqual(rect);
        expect(box.fit).toBe(fit);
        expect(box.mediaKind).toBe(mediaKind);
        expect(box.intrinsicSize).toEqual(intrinsicSize);
      });
    }
  }

  // The property each of the two scaled modes exists for, asserted as a relation rather than as numbers,
  // so it holds for sizes nobody wrote a row for.
  it('keeps contain inside the frame on every edge and cover around it on every edge', async () => {
    for (const intrinsicSize of [WIDER, TALLER]) {
      const inside = mediaBoxOf(
        await prepare({ model: songModel([mediaBox({ fit: 'contain', intrinsicSize })]), measurer: stubMeasurer() }),
      ).mediaRect;
      const over = mediaBoxOf(
        await prepare({ model: songModel([mediaBox({ fit: 'cover', intrinsicSize })]), measurer: stubMeasurer() }),
      ).mediaRect;
      const { x, y, width, height } = MEDIA_FRAME_PX;

      expect(inside.x).toBeGreaterThanOrEqual(x);
      expect(inside.y).toBeGreaterThanOrEqual(y);
      expect(inside.x + inside.width).toBeLessThanOrEqual(x + width);
      expect(inside.y + inside.height).toBeLessThanOrEqual(y + height);

      expect(over.x).toBeLessThanOrEqual(x);
      expect(over.y).toBeLessThanOrEqual(y);
      expect(over.x + over.width).toBeGreaterThanOrEqual(x + width);
      expect(over.y + over.height).toBeGreaterThanOrEqual(y + height);
    }
  });

  it('copies the intrinsic size it was handed rather than freezing the caller’s object', async () => {
    const intrinsicSize = { width: 1600, height: 400 };
    const prepared = await prepare({ model: songModel([mediaBox({ intrinsicSize })]), measurer: stubMeasurer() });

    expect(Object.isFrozen(intrinsicSize)).toBe(false);
    expect(mediaBoxOf(prepared).intrinsicSize).toEqual(intrinsicSize);
    expect(mediaBoxOf(prepared).intrinsicSize).not.toBe(intrinsicSize);
  });

  // A bad intrinsic size is a producer defect like any other, so it is refused in the same walk and with
  // the same class: a caller sorting bad input from an unexpected crash reads one `instanceof`.
  it('refuses a picture with no size to scale', async () => {
    await expect(
      prepare({ model: songModel([mediaBox({ intrinsicSize: { width: 0, height: 400 } })]), measurer: stubMeasurer() }),
    ).rejects.toBeInstanceOf(RenderModelError);
    await expect(
      prepare({
        model: songModel([mediaBox({ intrinsicSize: { width: 1600, height: Number.NaN } })]),
        measurer: stubMeasurer(),
      }),
    ).rejects.toThrow(/intrinsic size of box .* is 1600xNaN/u);
  });

  // The guard inside the geometry helper is what protects a caller that never goes through preparation. It
  // is unreachable from `prepareRenderModel` now that the size is refused first, which is the point — but
  // it still has to hold, and its class still has to be nameable from the package's entry point.
  it('keeps a geometry refusal of its own for a caller that skips preparation', () => {
    expect(() => mediaRectFor(MEDIA_FRAME_PX, { width: 0, height: 400 }, 'contain')).toThrow(MediaGeometryError);
    expect(isScalableSize({ width: 1600, height: 400 })).toBe(true);
    expect(isScalableSize({ width: 1600, height: 0 })).toBe(false);
  });
});

describe('how loud a slide is allowed to be', () => {
  const video = (volume: number, rest: { loop: boolean; muted: boolean } = { loop: false, muted: false }) =>
    mediaBox({ id: 'clip', mediaKind: 'video', fit: 'cover', audio: { ...rest, volume } });

  it('passes loop, mute and an in-bound volume through untouched', async () => {
    const prepared = await prepare({
      model: songModel([video(0.6, { loop: true, muted: true })]),
      measurer: stubMeasurer(),
    });

    expect(mediaBoxOf(prepared).audio).toEqual({
      loop: true,
      muted: true,
      volume: 0.6,
      requestedVolume: 0.6,
      maximumVolume: DEFAULT_MAXIMUM_AUDIO_VOLUME,
    });
    expect(prepared.findings).toEqual([]);
    expect(prepared.readiness).toBe('ready');
  });

  it('clamps a volume above the resolved bound and says so instead of throwing', async () => {
    const prepared = await prepare({
      model: songModel([video(0.9, { loop: true, muted: false })]),
      measurer: stubMeasurer(),
      service: { maximumAudioVolume: 0.5 },
    });

    expect(mediaBoxOf(prepared).audio).toEqual({
      loop: true,
      muted: false,
      volume: 0.5,
      requestedVolume: 0.9,
      maximumVolume: 0.5,
    });
    expect(prepared.findings).toContainEqual(
      expect.objectContaining({ code: 'media.volumeAboveBound', severity: 'warning', boxId: 'clip' }),
    );
    expect(prepared.readiness).toBe('warned');
  });

  // The other end of the same range: a correction nobody is told about is how a producer comes to believe
  // a defect was honoured, so silence is said out loud exactly the way the bound is.
  it('raises a volume below silence to silence and says so instead of correcting it quietly', async () => {
    const prepared = await prepare({ model: songModel([video(-0.2)]), measurer: stubMeasurer() });

    expect(mediaBoxOf(prepared).audio).toEqual({
      loop: false,
      muted: false,
      volume: 0,
      requestedVolume: -0.2,
      maximumVolume: DEFAULT_MAXIMUM_AUDIO_VOLUME,
    });
    expect(prepared.findings).toContainEqual(
      expect.objectContaining({ code: 'media.volumeBelowSilence', severity: 'warning', boxId: 'clip' }),
    );
    expect(prepared.readiness).toBe('warned');
  });

  it('takes the bound from the output type when administration set one for it', async () => {
    const defaults = { ...administrativeDefaults, byOutputType: { main: { maximumAudioVolume: 0.25 } } };
    const prepared = await prepare({ model: songModel([video(0.4)]), measurer: stubMeasurer(), defaults });

    expect(mediaBoxOf(prepared).audio?.volume).toBe(0.25);
    expect(mediaBoxOf(prepared).audio?.maximumVolume).toBe(0.25);
  });

  it('leaves a box with no audio settings carrying none', async () => {
    const prepared = await prepare({ model: songModel([mediaBox()]), measurer: stubMeasurer() });

    expect(mediaBoxOf(prepared).audio).toBeUndefined();
    expect(prepared.findings).toEqual([]);
  });

  it('refuses audio settings on a picture that cannot be heard', async () => {
    await expect(
      prepare({
        model: songModel([mediaBox({ audio: { loop: false, muted: false, volume: 0.5 } })]),
        measurer: stubMeasurer(),
      }),
    ).rejects.toThrow(/only a video can be heard/u);
  });

  // A clamp would leave the `NaN` in the frame, and a frame whose bytes are supposed to be comparable
  // cannot carry one.
  it('refuses a volume that is not a number rather than clamping it', async () => {
    await expect(
      prepare({ model: songModel([video(Number.NaN)]), measurer: stubMeasurer() }),
    ).rejects.toBeInstanceOf(RenderModelError);
  });
});

describe('a media box the surface could not play', () => {
  const STATES: readonly { readonly state: MediaPlaybackState; readonly recovery: MediaRecovery }[] = [
    { state: 'ok', recovery: 'none' },
    { state: 'autoplay-blocked', recovery: 'resume-playback' },
    { state: 'load-error', recovery: 'retry-load' },
  ];

  const preparing = async (playbackState?: MediaPlaybackState) =>
    mediaBoxOf(
      await prepare({
        model: songModel([
          mediaBox({
            id: 'clip',
            mediaKind: 'video',
            fit: 'cover',
            intrinsicSize: WIDER,
            audio: { loop: true, muted: false, volume: 0.4 },
            ...(playbackState === undefined ? {} : { playbackState }),
          }),
        ]),
        measurer: stubMeasurer(),
      }),
    );

  it('reads a box that was never told anything went wrong as playing', async () => {
    const box = await preparing();

    expect(box.playbackState).toBe('ok');
    expect(box.recovery).toBe('none');
  });

  for (const { state, recovery } of STATES) {
    it(`keeps the whole box, and names the way back, when playback is ${state}`, async () => {
      const box = await preparing(state);
      const playing = await preparing('ok');

      expect(box.playbackState).toBe(state);
      expect(box.recovery).toBe(recovery);
      // Not a blank frame, not a placeholder, not an omitted box: the same rectangle a playing one gets.
      expect(box.mediaRect).toEqual(playing.mediaRect);
      expect(box.mediaRect).toEqual({ x: -288, y: 216, width: 1728, height: 432 });
      expect(box.frame).toEqual(MEDIA_FRAME_PX);
      expect(box.audio).toEqual(playing.audio);
      expect(box.kind).toBe('media');
    });
  }
});
