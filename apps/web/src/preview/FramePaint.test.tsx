// @vitest-environment happy-dom

import { render, screen } from '@testing-library/preact';
import { describe, expect, it } from 'vitest';

import type { RenderFrame } from '@holydeck/renderer/renderer';
import type { SurfaceRender } from '@holydeck/renderer/surfaces';

import { API } from '../api-routes.js';

import { FramePaint } from './FramePaint.js';

function frameOf(slides: RenderFrame['slides']): RenderFrame {
  return {
    modelId: 'm1',
    outputType: 'audience',
    aspectRatio: { width: 16, height: 9 },
    canvas: { width: 1920, height: 1080 },
    safeArea: { x: 96, y: 54, width: 1728, height: 972 },
    minimumFontSizePx: 10,
    slides,
    findings: [],
    readiness: 'ready',
  };
}

function surfaceRenderWith(mediaKind: 'image' | 'video'): SurfaceRender {
  return {
    surface: 'editor-preview',
    frame: frameOf([
      {
        id: 'sl1',
        index: 0,
        letterbox: { x: 0, y: 0, width: 1920, height: 1080 },
        boxes: [
          {
            id: 't1', kind: 'text', importance: 'required', order: 0,
            frame: { x: 100, y: 50, width: 400, height: 100 },
            text: 'Hello', fontFamily: 'var(--font-latin)', fontWeight: 400, fontSizePx: 40, lineHeightPx: 48, lineCount: 1,
          },
          {
            id: 'm1', kind: 'media', importance: 'required', order: 1,
            frame: { x: 0, y: 200, width: 1920, height: 880 },
            mediaKind, fit: 'contain',
            mediaRect: { x: 200, y: 220, width: 1520, height: 855 },
            playbackState: 'ok', recovery: 'none',
          },
        ],
      },
    ]),
    paint: { widthPx: 960, heightPx: 540, scale: 0.5 },
  };
}

const surfaceRender = surfaceRenderWith('image');

describe('FramePaint', () => {
  it('positions a text box at its frame times scale, with its font', () => {
    render(<FramePaint render={surfaceRender} mediaOf={new Map()} label="Preview of Welcome" />);
    const [text] = screen.getAllByText('Hello').filter((el) => !el.classList.contains('visually-hidden'));
    if (text === undefined) throw new Error('text box not found');
    expect(text.style.left).toBe('50px');
    expect(text.style.top).toBe('25px');
    expect(text.style.width).toBe('200px');
    expect(text.style.height).toBe('50px');
    expect(text.style.fontFamily).toBe('var(--font-latin)');
    expect(text.style.fontSize).toBe('20px');
  });

  it('wraps a long word and spaces letters the way the server measured them', () => {
    const [slide] = surfaceRender.frame.slides;
    if (slide === undefined) throw new Error('no slide');
    const spaced: SurfaceRender = {
      ...surfaceRender,
      frame: frameOf([{ ...slide, boxes: slide.boxes.map((box) => (box.kind === 'text' ? { ...box, letterSpacingPx: 4 } : box)) }]),
    };
    render(<FramePaint render={spaced} mediaOf={new Map()} label="Preview" />);
    const [text] = screen.getAllByText('Hello').filter((el) => !el.classList.contains('visually-hidden'));
    expect(text?.style.getPropertyValue('overflow-wrap')).toBe('break-word');
    expect(text?.style.letterSpacing).toBe('2px');
  });

  it('positions a media box image at mediaRect, relative to its own frame, times scale', () => {
    const mediaOf = new Map([['m1', 'asset-1']]);
    render(<FramePaint render={surfaceRender} mediaOf={mediaOf} label="Preview" />);
    const img = screen.getByRole('img', { name: 'Preview' }).querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe(API.mediaContent('asset-1'));
    expect(img?.style.left).toBe('100px');
    expect(img?.style.top).toBe('10px');
    expect(img?.style.width).toBe('760px');
    expect(img?.style.height).toBe('427.5px');
  });

  it('uses the poster derivative for a video media box', () => {
    const mediaOf = new Map([['m1', 'asset-2']]);
    render(<FramePaint render={surfaceRenderWith('video')} mediaOf={mediaOf} label="Preview" />);
    const img = screen.getByRole('img', { name: 'Preview' }).querySelector('img');
    expect(img?.getAttribute('src')).toBe(API.mediaDerivative('asset-2', 'poster'));
  });

  it('renders role img with the given label, and the slide text in a visually-hidden block', () => {
    render(<FramePaint render={surfaceRender} mediaOf={new Map()} label="Preview of Welcome" />);
    const figure = screen.getByRole('img', { name: 'Preview of Welcome' });
    const hidden = figure.querySelector('.visually-hidden');
    expect(hidden?.textContent).toBe('Hello');
  });
});
