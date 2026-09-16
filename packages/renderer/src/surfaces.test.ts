import { describe, expect, it } from 'vitest';

import { stubMeasurer } from '../test/helpers/measurer.js';
import { songModel } from '../test/helpers/model.js';
import { prepareRenderModel } from './render-model.js';
import { frameBytes, serializeFrame } from './renderer.js';
import {
  RENDER_SURFACES,
  renderEditorPreview,
  renderForSurface,
  renderOfflineRender,
  renderOutputView,
  renderThumbnail,
} from './surfaces.js';

const prepared = async () => prepareRenderModel({ model: songModel(), measurer: stubMeasurer() });

describe('one renderer behind every surface', () => {
  it('produces byte-identical output from all four surface calling conventions', async () => {
    const model = await prepared();

    // Four genuinely different call shapes: a live preview scaled into an editor pane, an offscreen
    // raster job, a full-screen output view, and an offline presenter with no options and no browser.
    const renders = [
      renderEditorPreview(model, { viewportWidthPx: 640 }),
      renderThumbnail(model, { widthPx: 320 }),
      renderOutputView(model, { displayWidthPx: 3840, displayHeightPx: 2160 }),
      renderOfflineRender(model),
    ];

    expect(renders.map((render) => render.surface)).toEqual([...RENDER_SURFACES]);
    const texts = renders.map((render) => serializeFrame(render.frame));
    expect(new Set(texts).size).toBe(1);
    const bytes = renders.map((render) => Buffer.from(frameBytes(render.frame)).toString('hex'));
    expect(new Set(bytes).size).toBe(1);
  });

  it('scales at paint time only, so surface pixels never reach the frame', async () => {
    const model = await prepared();
    const thumbnail = renderThumbnail(model, { widthPx: 320 });
    const outputView = renderOutputView(model, { displayWidthPx: 3840, displayHeightPx: 2160 });

    expect(thumbnail.paint).toEqual({ widthPx: 320, heightPx: 180, scale: 320 / model.canvas.width });
    expect(outputView.paint.widthPx).toBe(3840);
    expect(serializeFrame(thumbnail.frame)).toBe(serializeFrame(outputView.frame));
  });

  it('fails the comparison when one surface renders a divergent model', async () => {
    const wide = await prepareRenderModel({
      model: songModel(),
      measurer: stubMeasurer(),
      service: { aspectRatio: { width: 4, height: 3 } },
    });
    const narrow = await prepared();

    expect(serializeFrame(renderOfflineRender(wide).frame)).not.toBe(
      serializeFrame(renderOfflineRender(narrow).frame),
    );
  });

  it('routes every declared surface through the same renderer', async () => {
    const model = await prepared();
    const frames = RENDER_SURFACES.map((surface) => serializeFrame(renderForSurface(surface, model).frame));
    expect(new Set(frames).size).toBe(1);
  });
});
