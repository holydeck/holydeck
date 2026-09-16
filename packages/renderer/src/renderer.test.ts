import { describe, expect, it } from 'vitest';

import { stubMeasurer } from '../test/helpers/measurer.js';
import { LYRIC, lyricBox, songModel } from '../test/helpers/model.js';
import { prepareRenderModel } from './render-model.js';
import { frameBytes, renderPrepared, serializeFrame } from './renderer.js';

import type { DecorationBox, RenderModelInput } from './render-model.js';

const decoration = (overrides: Partial<DecorationBox> = {}): DecorationBox => ({
  id: 'flourish',
  kind: 'decoration',
  frame: { x: 0.02, y: 0.02, width: 0.2, height: 0.1 },
  importance: 'decoration',
  ...overrides,
});

const render = async (model: RenderModelInput) =>
  renderPrepared(await prepareRenderModel({ model, measurer: stubMeasurer() }));

describe('the rendered frame', () => {
  it('draws the resolved canvas, safe area and boxes in declaration order', async () => {
    const frame = await render({
      id: 'set-1',
      outputType: 'main',
      slides: [{ id: 'slide-1', boxes: [decoration(), lyricBox()] }],
    });

    expect(frame.canvas).toEqual({ width: 1920, height: 1080 });
    expect(frame.safeArea).toEqual({ x: 96, y: 54, width: 1728, height: 972 });
    expect(frame.slides[0]?.boxes.map((box) => [box.id, box.order])).toEqual([
      ['flourish', 0],
      ['lyric', 1],
    ]);
    expect(frame.slides[0]?.index).toBe(0);
  });

  it('carries the type a surface has to paint and nothing a surface has to decide', async () => {
    const frame = await render(songModel());
    const box = frame.slides[0]?.boxes[0];

    expect(box).toMatchObject({ kind: 'text', text: LYRIC, fontFamily: 'Inter', fontWeight: 600 });
    expect(box?.lineHeightPx).toBe(Number(((box?.fontSizePx ?? 0) * 1.2).toFixed(3)));
    expect(box?.lineCount).toBeGreaterThan(0);
  });

  it('leaves a decoration box with no type on it at all', async () => {
    const frame = await render({ id: 'set-1', outputType: 'main', slides: [{ id: 'slide-1', boxes: [decoration()] }] });
    const box = frame.slides[0]?.boxes[0];

    expect(box?.kind).toBe('decoration');
    expect(box?.text).toBeUndefined();
    expect(box?.fontSizePx).toBeUndefined();
  });

  it('is frozen, so nothing downstream can edit a frame instead of re-preparing one', async () => {
    const frame = await render(songModel());
    expect(() => {
      (frame as { readiness: string }).readiness = 'ready';
    }).toThrow(TypeError);
  });

  it('serializes to the same bytes twice and to different bytes for a different model', async () => {
    const one = await render(songModel());
    const two = await render(songModel());
    const other = await render(songModel([lyricBox({ text: 'A different verse entirely' })]));

    expect(serializeFrame(one)).toBe(serializeFrame(two));
    expect(Buffer.from(frameBytes(one))).toEqual(Buffer.from(frameBytes(two)));
    expect(serializeFrame(one)).not.toBe(serializeFrame(other));
  });
});

describe('the safe area an editor sees over a preview', () => {
  it('blocks on required content outside it and only warns on decoration', async () => {
    const outside = { x: 0.9, y: 0.9, width: 0.2, height: 0.2 };
    const frame = await render({
      id: 'set-1',
      outputType: 'main',
      slides: [
        {
          id: 'slide-1',
          boxes: [decoration({ frame: outside }), lyricBox({ id: 'strayed', frame: outside })],
        },
      ],
    });

    expect(frame.findings).toContainEqual(
      expect.objectContaining({ code: 'decoration.outsideSafeArea', severity: 'warning', boxId: 'flourish' }),
    );
    expect(frame.findings).toContainEqual(
      expect.objectContaining({ code: 'content.outsideSafeArea', severity: 'blocker', boxId: 'strayed' }),
    );
    expect(frame.readiness).toBe('blocked');
  });

  it('reports ready when every box sits inside it and fits', async () => {
    const frame = await render(songModel());
    expect(frame.findings).toEqual([]);
    expect(frame.readiness).toBe('ready');
  });
});

describe('a Slide Layout authored at another ratio', () => {
  it('letterboxes the layout whole rather than cropping it, and warns', async () => {
    const frame = await render({
      id: 'set-1',
      outputType: 'main',
      slides: [{ id: 'slide-1', layoutAspectRatio: { width: 4, height: 3 }, boxes: [lyricBox()] }],
    });

    // 4:3 inside a 1920x1080 canvas is 1440 wide, centred: pillarboxed, with nothing cut off.
    expect(frame.slides[0]?.letterbox).toEqual({ x: 240, y: 0, width: 1440, height: 1080 });
    expect(frame.findings).toContainEqual(
      expect.objectContaining({ code: 'layout.ratioMismatch', severity: 'warning', slideId: 'slide-1' }),
    );
    expect(frame.readiness).toBe('warned');
  });

  it('says nothing when the authored ratio is the output ratio written differently', async () => {
    const frame = await render({
      id: 'set-1',
      outputType: 'main',
      slides: [{ id: 'slide-1', layoutAspectRatio: { width: 32, height: 18 }, boxes: [lyricBox()] }],
    });

    expect(frame.slides[0]?.letterbox).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(frame.findings).toEqual([]);
  });
});
