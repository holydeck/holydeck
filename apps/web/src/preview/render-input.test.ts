import { describe, expect, it } from 'vitest';

import { administrativeDefaults } from '@holydeck/renderer/output-profile';
import { prepareRenderModel } from '@holydeck/renderer/render-model';
import type { TextMeasurer } from '@holydeck/renderer/measure';
import type { CustomSlideBody, ReadingBody } from '@holydeck/contracts/services';

import { renderInputFor, type LayoutBody, type PreviewSource } from './render-input.js';

const output = { aspectRatio: '16:9', safeAreaMargins: { unit: 'percent' as const, top: 5, right: 5, bottom: 5, left: 5 } };

const noMeasurer: TextMeasurer = { measure: async () => [], close: async () => {} };

describe('renderInputFor', () => {
  it('divides safe-area percent by 100 exactly once (P-24)', () => {
    const source: PreviewSource = { kind: 'custom-slide', body: { kind: 'custom-slide', boxes: [] } };
    const { defaults } = renderInputFor('item', source, output);
    expect(defaults.safeArea).toEqual({ unit: 'percent', top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 });
  });

  it('a song-generated slide group with no layout falls back to one box per enabled slide (P-26)', () => {
    const source: PreviewSource = {
      kind: 'slide-group',
      group: {
        id: 'g1',
        revision: 1,
        slides: [
          { id: 'sl1', enabled: true, blocks: [{ language: 'en', text: 'Amazing grace' }, { language: 'ta', text: 'தமிழ்' }] },
          { id: 'sl2', enabled: false, blocks: [{ language: 'en', text: 'skip me' }] },
        ],
      },
    };
    const { model, defaults } = renderInputFor('item1', source, output);

    expect(model.slides).toHaveLength(1);
    expect(model.slides[0]?.id).toBe('sl1');
    expect(model.slides[0]?.boxes).toHaveLength(1);
    const box = model.slides[0]?.boxes[0];
    expect(box?.kind).toBe('text');
    expect(box?.kind === 'text' && box.text).toBe('Amazing grace');
    expect(box?.kind === 'text' && box.font.family).toBe('var(--font-latin)');
    expect(box?.frame).toEqual({ x: 0.05, y: 0.05, width: 0.9, height: 0.9 });
    void defaults;
  });

  it('a slide group with a per-slide layout override maps boxes 1:1 by binding', () => {
    const layout: LayoutBody = {
      boxes: [
        {
          id: 'b1', kind: 'text', frame: { x: 0, y: 0, width: 1, height: 0.2 }, importance: 'required',
          binding: { mode: 'keyed', contentKind: 'song', contentKey: 'lyricLine', languageKey: 'en' },
          style: { fontFamily: 'serif', fontWeight: 400, sizeRatio: 0.1, lineHeight: 1.2, align: 'center', verticalAlign: 'center' },
        },
        {
          id: 'b2', kind: 'text', frame: { x: 0, y: 0.2, width: 1, height: 0.2 }, importance: 'decoration',
          binding: { mode: 'static', text: 'Static caption' },
          style: { fontFamily: 'serif', fontWeight: 700, sizeRatio: 0.05, lineHeight: 1, align: 'start', verticalAlign: 'start' },
        },
        {
          id: 'b3', kind: 'media', frame: { x: 0, y: 0.4, width: 1, height: 0.6 }, importance: 'decoration',
          style: { fit: 'cover', opacity: 1 },
        },
      ],
    };
    const source: PreviewSource = {
      kind: 'slide-group',
      group: { id: 'g2', revision: 1, slides: [{ id: 'sl1', enabled: true, blocks: [{ language: 'en', text: 'Line one' }] }] },
      layout,
    };
    const { model } = renderInputFor('item2', source, output);

    const boxes = model.slides[0]?.boxes ?? [];
    expect(boxes).toHaveLength(3);
    expect(boxes[0]).toMatchObject({ id: 'b1', kind: 'text', text: 'Line one', frame: { x: 0, y: 0, width: 1, height: 0.2 } });
    expect(boxes[0]?.kind === 'text' && boxes[0].font).toEqual({ family: 'serif', weight: 400, sizeRatio: 0.1, lineHeight: 1.2 });
    expect(boxes[0]?.kind === 'text' && boxes[0].font).not.toHaveProperty('align');
    expect(boxes[1]).toMatchObject({ id: 'b2', kind: 'text', text: 'Static caption' });
    // A Layout Media box binds no asset yet, so it degrades to a decoration placeholder.
    expect(boxes[2]).toMatchObject({ id: 'b3', kind: 'decoration', importance: 'decoration' });
  });

  it('a reading with two translations keys its boxes by translation, and falls back without a layout', () => {
    const body: ReadingBody = { kind: 'reading', translation: 'KJV', compare: ['ESV'], book: 'John', chapter: 3, verses: '16' };
    const passages = [
      { translation: 'KJV', text: 'For God so loved the world...' },
      { translation: 'ESV', text: 'For God so loved the world, that he gave...' },
    ];

    const withoutLayout = renderInputFor('item3', { kind: 'reading', body, passages }, output);
    expect(withoutLayout.model.slides).toHaveLength(1);
    const fallbackBox = withoutLayout.model.slides[0]?.boxes[0];
    expect(fallbackBox?.kind === 'text' && fallbackBox.text).toBe(passages[0]?.text);

    const layout: LayoutBody = {
      boxes: [
        {
          id: 'kjv', kind: 'text', frame: { x: 0, y: 0, width: 1, height: 0.5 }, importance: 'required',
          binding: { mode: 'keyed', contentKind: 'reading', contentKey: 'verseText', languageKey: 'KJV' },
          style: { fontFamily: 'var(--font-latin)', fontWeight: 400, sizeRatio: 0.08, lineHeight: 1.3, align: 'start', verticalAlign: 'start' },
        },
        {
          id: 'esv', kind: 'text', frame: { x: 0, y: 0.5, width: 1, height: 0.5 }, importance: 'required',
          binding: { mode: 'keyed', contentKind: 'reading', contentKey: 'verseText', languageKey: 'ESV' },
          style: { fontFamily: 'var(--font-latin)', fontWeight: 400, sizeRatio: 0.08, lineHeight: 1.3, align: 'start', verticalAlign: 'start' },
        },
      ],
    };
    const withLayout = renderInputFor('item3', { kind: 'reading', body, passages, layout }, output);
    const boxes = withLayout.model.slides[0]?.boxes ?? [];
    expect(boxes.find((box) => box.id === 'kjv')?.kind === 'text' && (boxes.find((box) => box.id === 'kjv') as { text: string }).text).toBe(passages[0]?.text);
    expect(boxes.find((box) => box.id === 'esv')?.kind === 'text' && (boxes.find((box) => box.id === 'esv') as { text: string }).text).toBe(passages[1]?.text);
  });

  it('a custom slide with a media box maps boxes 1:1, sorted by layer, and records mediaOf', () => {
    const body: CustomSlideBody = {
      kind: 'custom-slide',
      boxes: [
        {
          id: 't1', kind: 'text', frame: { x: 0, y: 0, width: 1, height: 0.2 }, layer: 1, text: 'Welcome',
          style: { fontFamily: 'var(--font-latin)', fontWeight: 400, sizeRatio: 0.15, lineHeight: 1.2, align: 'center', verticalAlign: 'center' },
        },
        {
          id: 'm1', kind: 'media', frame: { x: 0, y: 0.2, width: 1, height: 0.8 }, layer: 0,
          mediaId: 'med-1', mediaKind: 'image', fit: 'cover', intrinsicSize: { width: 1600, height: 900 },
        },
      ],
    };
    const { model, mediaOf } = renderInputFor('item4', { kind: 'custom-slide', body }, output);

    const boxes = model.slides[0]?.boxes ?? [];
    expect(boxes.map((box) => box.id)).toEqual(['m1', 't1']);
    expect(boxes[0]).toMatchObject({ kind: 'media', mediaKind: 'image', fit: 'cover', intrinsicSize: { width: 1600, height: 900 } });
    expect(boxes[1]).toMatchObject({ kind: 'text', text: 'Welcome' });
    expect(mediaOf.get('m1')).toBe('med-1');
  });

  it('letterboxes a 4:3 output against a 16:9 media item, never cropping it', async () => {
    const source: PreviewSource = { kind: 'media', mediaId: 'med-2', mediaKind: 'image', intrinsicSize: { width: 1920, height: 1080 } };
    const fourByThree = { aspectRatio: '4:3', safeAreaMargins: { unit: 'percent' as const, top: 5, right: 5, bottom: 5, left: 5 } };
    const { model, defaults, mediaOf } = renderInputFor('item5', source, fourByThree);

    expect(defaults.aspectRatio).toEqual({ width: 4, height: 3 });
    expect(model.slides[0]?.layoutAspectRatio).toEqual({ width: 1920, height: 1080 });
    expect(mediaOf.get(`${model.slides[0]?.boxes[0]?.id}`)).toBe('med-2');
    expect(model.slides[0]?.boxes[0]?.importance).toBe('decoration');

    const prepared = await prepareRenderModel({
      model: { ...model, outputType: 'audience' },
      measurer: noMeasurer,
      defaults: { ...administrativeDefaults, aspectRatio: defaults.aspectRatio, safeArea: defaults.safeArea },
    });
    const letterbox = prepared.slides[0]?.letterbox;
    expect(letterbox?.width).toBe(prepared.canvas.width);
    expect(letterbox?.height).toBeLessThan(prepared.canvas.height);
  });
});
