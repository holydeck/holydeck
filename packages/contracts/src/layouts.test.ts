import { describe, expect, it } from 'vitest';

import {
  BOX_IMPORTANCES,
  BOX_KINDS,
  LAYOUT_NAME,
  parseSlideLayoutBody,
  parseSlideLayoutDraft,
  parseSlideLayoutStatus,
  SLIDE_LAYOUTS_PATH,
} from './layouts.js';

const textBox = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'lyric',
  kind: 'text',
  importance: 'required',
  frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.5 },
  style: { fontFamily: 'Inter', fontWeight: 600, sizeRatio: 0.08, lineHeight: 1.25, align: 'center', verticalAlign: 'center' },
  ...over,
});

const mediaBox = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'backdrop',
  kind: 'media',
  importance: 'decoration',
  frame: { x: 0, y: 0, width: 1, height: 1 },
  style: { fit: 'cover', opacity: 0.4 },
  ...over,
});

const problemsOf = (value: unknown): readonly string[] => {
  const parsed = parseSlideLayoutBody(value);
  return parsed.ok ? [] : parsed.problems.map((problem) => `${problem.path}: ${problem.code}`);
};

const messagesOf = (value: unknown): readonly string[] => {
  const parsed = parseSlideLayoutBody(value);
  return parsed.ok ? [] : parsed.problems.map((problem) => `${problem.path}: ${problem.message}`);
};

describe('the shape a Slide Layout is', () => {
  it('names the two kinds of box and the two ways one is graded against the safe area', () => {
    expect([...BOX_KINDS]).toEqual(['text', 'media']);
    expect([...BOX_IMPORTANCES]).toEqual(['required', 'decoration']);
    expect(SLIDE_LAYOUTS_PATH).toBe('/api/v1/slide-layouts');
  });

  it('accepts a fully positioned Text box and a fully positioned Media box, and keeps them verbatim', () => {
    const parsed = parseSlideLayoutBody({ boxes: [mediaBox(), textBox()] });
    expect(parsed).toEqual({
      ok: true,
      value: {
        boxes: [
          {
            id: 'backdrop',
            kind: 'media',
            importance: 'decoration',
            frame: { x: 0, y: 0, width: 1, height: 1 },
            style: { fit: 'cover', opacity: 0.4 },
          },
          {
            id: 'lyric',
            kind: 'text',
            importance: 'required',
            frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.5 },
            style: {
              fontFamily: 'Inter',
              fontWeight: 600,
              sizeRatio: 0.08,
              lineHeight: 1.25,
              align: 'center',
              verticalAlign: 'center',
            },
          },
        ],
      },
    });
  });

  it('carries the opaque stand-in text a box has, and nothing at all where a box has none', () => {
    const parsed = parseSlideLayoutBody({ boxes: [textBox({ placeholder: 'Verse 1' })] });
    expect(parsed.ok && parsed.value.boxes[0]?.placeholder).toBe('Verse 1');
    const bare = parseSlideLayoutBody({ boxes: [textBox()] });
    expect(bare.ok && Object.keys(bare.value.boxes[0] ?? {})).not.toContain('placeholder');
  });
});

describe('a box nobody positioned', () => {
  it('fails with the geometry field it is missing, named in full', () => {
    expect(problemsOf({ boxes: [textBox({ frame: { x: 0.1, y: 0.2, height: 0.5 } })] })).toEqual([
      'layout.boxes.0.frame.width: field.required',
    ]);
    expect(problemsOf({ boxes: [textBox({ frame: { width: 0.8, height: 0.5 } })] })).toEqual([
      'layout.boxes.0.frame.x: field.required',
      'layout.boxes.0.frame.y: field.required',
    ]);
    expect(problemsOf({ boxes: [textBox({ frame: {} })] })).toEqual([
      'layout.boxes.0.frame.x: field.required',
      'layout.boxes.0.frame.y: field.required',
      'layout.boxes.0.frame.width: field.required',
      'layout.boxes.0.frame.height: field.required',
    ]);
    expect(problemsOf({ boxes: [textBox({ frame: undefined })] })).toEqual(['layout.boxes.0.frame: field.required']);
  });

  it('fails when a coordinate is not a share of the slide, or leaves no area to draw in', () => {
    expect(problemsOf({ boxes: [textBox({ frame: { x: -0.1, y: 0.2, width: 0.8, height: 0.5 } })] })).toEqual([
      'layout.boxes.0.frame.x: field.too_small',
    ]);
    expect(problemsOf({ boxes: [textBox({ frame: { x: 0.1, y: 1.5, width: 0.8, height: 0.5 } })] })).toEqual([
      'layout.boxes.0.frame.y: field.too_large',
    ]);
    expect(problemsOf({ boxes: [textBox({ frame: { x: 0.1, y: 0.2, width: 0, height: 0.5 } })] })).toEqual([
      'layout.boxes.0.frame.width: field.too_small',
    ]);
    expect(problemsOf({ boxes: [textBox({ frame: { x: 0.1, y: 0.2, width: '0.8', height: 0.5 } })] })).toEqual([
      'layout.boxes.0.frame.width: field.not_a_number',
    ]);
  });

  it('fails when a box that is positioned reaches past the slide it sits on', () => {
    expect(problemsOf({ boxes: [textBox({ frame: { x: 0.5, y: 0.2, width: 0.8, height: 0.5 } })] })).toEqual([
      'layout.boxes.0.frame.width: field.too_large',
    ]);
    expect(problemsOf({ boxes: [textBox({ frame: { x: 0.1, y: 0.8, width: 0.8, height: 0.5 } })] })).toEqual([
      'layout.boxes.0.frame.height: field.too_large',
    ]);
    // The edge itself is not past the edge, however the arithmetic happens to land.
    expect(parseSlideLayoutBody({ boxes: [textBox({ frame: { x: 0.1, y: 0.2, width: 0.9, height: 0.8 } })] }).ok).toBe(true);
  });
});

describe('what a box carries besides its geometry', () => {
  it('refuses a kind, an importance, or a style field this release does not know', () => {
    expect(problemsOf({ boxes: [textBox({ kind: 'chart' })] })).toEqual(['layout.boxes.0.kind: field.not_allowed']);
    expect(problemsOf({ boxes: [textBox({ importance: 'nice-to-have' })] })).toEqual([
      'layout.boxes.0.importance: field.not_allowed',
    ]);
    expect(problemsOf({ boxes: [textBox({ style: { ...(textBox().style as object), align: 'justify' } })] })).toEqual([
      'layout.boxes.0.style.align: field.not_allowed',
    ]);
    expect(problemsOf({ boxes: [mediaBox({ style: { fit: 'stretch', opacity: 0.4 } })] })).toEqual([
      'layout.boxes.0.style.fit: field.not_allowed',
    ]);
  });

  it('refuses a Text style whose type could not be laid out', () => {
    const style = textBox().style as Record<string, unknown>;
    expect(problemsOf({ boxes: [textBox({ style: { ...style, fontWeight: 1000 } })] })).toEqual([
      'layout.boxes.0.style.fontWeight: field.too_large',
    ]);
    expect(problemsOf({ boxes: [textBox({ style: { ...style, fontWeight: 50 } })] })).toEqual([
      'layout.boxes.0.style.fontWeight: field.too_small',
    ]);
    expect(problemsOf({ boxes: [textBox({ style: { ...style, sizeRatio: 0 } })] })).toEqual([
      'layout.boxes.0.style.sizeRatio: field.too_small',
    ]);
    expect(problemsOf({ boxes: [textBox({ style: { ...style, lineHeight: 0.5 } })] })).toEqual([
      'layout.boxes.0.style.lineHeight: field.too_small',
    ]);
    expect(problemsOf({ boxes: [textBox({ style: undefined })] })).toEqual(['layout.boxes.0.style: field.required']);
  });

  it('tells a type size of none what a type size is, rather than talking about the slide', () => {
    const style = textBox().style as Record<string, unknown>;
    expect(messagesOf({ boxes: [textBox({ style: { ...style, sizeRatio: 0 } })] })).toEqual([
      'layout.boxes.0.style.sizeRatio: must be a size type can be read at',
    ]);
    // The same rule on a frame is about the slide, which is where that sentence belongs and the only place.
    expect(messagesOf({ boxes: [textBox({ frame: { x: 0, y: 0, width: 0, height: 0.5 } })] })).toEqual([
      'layout.boxes.0.frame.width: must leave some of the slide to draw in',
    ]);
  });

  it('refuses a Media style that would draw nothing or refuse to be seen through', () => {
    expect(problemsOf({ boxes: [mediaBox({ style: { fit: 'cover', opacity: 1.2 } })] })).toEqual([
      'layout.boxes.0.style.opacity: field.too_large',
    ]);
    expect(problemsOf({ boxes: [mediaBox({ style: { fit: 'cover' } })] })).toEqual([
      'layout.boxes.0.style.opacity: field.required',
    ]);
  });

  it('refuses a box with no identifier, and two boxes sharing one', () => {
    expect(problemsOf({ boxes: [textBox({ id: '' })] })).toEqual(['layout.boxes.0.id: field.empty']);
    expect(problemsOf({ boxes: [textBox(), mediaBox({ id: 'lyric' })] })).toEqual(['layout.boxes: field.not_allowed']);
  });
});

describe('the list of boxes itself', () => {
  it('refuses a Layout with nothing on it, and one that is not a list of boxes at all', () => {
    expect(problemsOf({ boxes: [] })).toEqual(['layout.boxes: field.empty']);
    expect(problemsOf({ boxes: 'lyric' })).toEqual(['layout.boxes: field.not_a_list']);
    expect(problemsOf({})).toEqual(['layout.boxes: field.required']);
    expect(problemsOf('lyric')).toEqual(['layout: field.not_an_object']);
  });

  it('reports every problem across every box at once rather than stopping at the first', () => {
    expect(problemsOf({ boxes: [textBox({ frame: {} }), mediaBox({ kind: 'chart' })] })).toEqual([
      'layout.boxes.0.frame.x: field.required',
      'layout.boxes.0.frame.y: field.required',
      'layout.boxes.0.frame.width: field.required',
      'layout.boxes.0.frame.height: field.required',
      'layout.boxes.1.kind: field.not_allowed',
    ]);
  });
});

describe('what a request to make or change a Slide Layout carries', () => {
  it('reads the name it is administered under alongside the boxes it is built from', () => {
    expect(parseSlideLayoutDraft({ name: 'Sermon point', boxes: [textBox()] })).toEqual({
      ok: true,
      value: { name: 'Sermon point', body: { boxes: [textBox()] } },
    });
  });

  it('refuses a name nobody could tell apart, and one longer than the field it is shown in', () => {
    const problems = (value: unknown): readonly string[] => {
      const parsed = parseSlideLayoutDraft(value);
      return parsed.ok ? [] : parsed.problems.map((problem) => `${problem.path}: ${problem.code}`);
    };
    expect(problems({ boxes: [textBox()] })).toEqual(['layout.name: field.required']);
    expect(problems({ name: '', boxes: [textBox()] })).toEqual(['layout.name: field.empty']);
    expect(problems({ name: 'x'.repeat(LAYOUT_NAME.maximum + 1), boxes: [textBox()] })).toEqual([
      'layout.name: field.too_large',
    ]);
    expect(problems({ name: 'Sermon point', boxes: [] })).toEqual(['layout.boxes: field.empty']);
  });

  it('reads whether a Layout is being hidden or brought back, and refuses anything else', () => {
    expect(parseSlideLayoutStatus({ archived: true })).toEqual({ ok: true, value: { archived: true } });
    const parsed = parseSlideLayoutStatus({ archived: 'yes' });
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problems.map((problem) => `${problem.path}: ${problem.code}`)).toEqual([
      'layout.archived: field.not_a_boolean',
    ]);
  });
});
