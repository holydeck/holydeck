import { describe, expect, it } from 'vitest';

import { canonicalJson } from './canonical.js';
import {
  BINDING_MODES,
  BOX_IMPORTANCES,
  BOX_KINDS,
  CONTENT_KEYS,
  CONTENT_KINDS,
  LAYOUT_NAME,
  parseSlideLayoutBody,
  parseSlideLayoutDraft,
  parseSlideLayoutStatus,
  SLIDE_LAYOUTS_PATH,
} from './layouts.js';

import type {
  BoxBinding,
  BoxFrame,
  MediaBoxStyle,
  MediaLayoutBox,
  SlideLayoutBody,
  TextBoxStyle,
  TextLayoutBox,
} from './layouts.js';

const LYRIC_BINDING = { mode: 'keyed', contentKind: 'song', contentKey: 'lyricLine', languageKey: 'ta' } as const;

const textBox = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'lyric',
  kind: 'text',
  importance: 'required',
  frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.5 },
  binding: { ...LYRIC_BINDING },
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

/** Every field name the first box of a Layout came back carrying. */
const fieldsOf = (value: unknown): readonly string[] => {
  const parsed = parseSlideLayoutBody(value);
  return parsed.ok ? Object.keys(parsed.value.boxes[0] ?? {}) : [];
};

/** What the first box of a Layout is bound to, or nothing when it was refused or carries no binding. */
const bindingOf = (value: unknown): BoxBinding | undefined => {
  const parsed = parseSlideLayoutBody(value);
  if (!parsed.ok) return undefined;
  const box = parsed.value.boxes[0];
  return box?.kind === 'text' ? box.binding : undefined;
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
            binding: { mode: 'keyed', contentKind: 'song', contentKey: 'lyricLine', languageKey: 'ta' },
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

  it('carries the opaque stand-in a Media box has, and nothing at all where one has none', () => {
    const parsed = parseSlideLayoutBody({ boxes: [mediaBox({ placeholder: 'still-01.jpg' })] });
    const box = parsed.ok ? parsed.value.boxes[0] : undefined;
    expect(box?.kind === 'media' && box.placeholder).toBe('still-01.jpg');
    expect(fieldsOf({ boxes: [mediaBox()] })).not.toContain('placeholder');
  });

  // A Text box says what it says through its binding, so a stand-in on one is a second source of truth
  // for the same words. It is not read, and never reaches the Layout that is stored.
  it('reads no stand-in on a Text box, which says what it says through its binding', () => {
    expect(parseSlideLayoutBody({ boxes: [textBox({ placeholder: 'Verse 1' })] }).ok).toBe(true);
    expect(fieldsOf({ boxes: [textBox({ placeholder: 'Verse 1' })] })).not.toContain('placeholder');
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

describe('what a Text box is bound to', () => {
  it('names the kinds of content a box can be bound to, and the keys each kind offers', () => {
    expect([...CONTENT_KINDS]).toEqual(['song', 'sermon', 'reading']);
    expect([...BINDING_MODES]).toEqual(['keyed', 'static']);
    expect([...CONTENT_KEYS.song]).toEqual(['title', 'lyricLine', 'author', 'copyright']);
    expect([...CONTENT_KEYS.sermon]).toEqual(['title', 'point', 'scriptureRef', 'speaker']);
    expect([...CONTENT_KEYS.reading]).toEqual(['reference', 'verseText', 'translation']);
    // A closed vocabulary that a caller could add a key to is not a closed vocabulary.
    expect(Object.isFrozen(CONTENT_KEYS)).toBe(true);
    expect(Object.isFrozen(CONTENT_KEYS.song)).toBe(true);
  });

  it('binds a box to one named field of one kind of content, in one named language', () => {
    expect(bindingOf({ boxes: [textBox()] })).toEqual({
      mode: 'keyed',
      contentKind: 'song',
      contentKey: 'lyricLine',
      languageKey: 'ta',
    });
  });

  it('refuses a key the kind of content it is bound to does not offer, and says which it does', () => {
    const bound = (over: Record<string, unknown>): Record<string, unknown> => textBox({ binding: { ...LYRIC_BINDING, ...over } });
    expect(problemsOf({ boxes: [bound({ contentKey: 'chorus' })] })).toEqual([
      'layout.boxes.0.binding.contentKey: field.not_allowed',
    ]);
    expect(messagesOf({ boxes: [bound({ contentKey: 'chorus' })] })).toEqual([
      'layout.boxes.0.binding.contentKey: must be one of title, lyricLine, author, copyright',
    ]);
    // The key of another kind of content is exactly the mistake this catches, and it reads the same way.
    expect(problemsOf({ boxes: [bound({ contentKey: 'speaker' })] })).toEqual([
      'layout.boxes.0.binding.contentKey: field.not_allowed',
    ]);
    expect(problemsOf({ boxes: [bound({ contentKind: 'sermon', contentKey: 'speaker' })] })).toEqual([]);
    expect(problemsOf({ boxes: [bound({ contentKey: undefined })] })).toEqual([
      'layout.boxes.0.binding.contentKey: field.required',
    ]);
  });

  // A kind this release does not have has no keys to grade a key against, so grading one anyway would
  // answer a question nobody asked with the key list of whichever kind happened to be first.
  it('refuses a kind of content this release does not have, and says nothing about its key', () => {
    expect(problemsOf({ boxes: [textBox({ binding: { ...LYRIC_BINDING, contentKind: 'liturgy' } })] })).toEqual([
      'layout.boxes.0.binding.contentKind: field.not_allowed',
    ]);
  });

  it('refuses a binding with no language, because every Text box binds a language as well as a key', () => {
    expect(problemsOf({ boxes: [textBox({ binding: { ...LYRIC_BINDING, languageKey: undefined } })] })).toEqual([
      'layout.boxes.0.binding.languageKey: field.required',
    ]);
    expect(problemsOf({ boxes: [textBox({ binding: { ...LYRIC_BINDING, languageKey: '' } })] })).toEqual([
      'layout.boxes.0.binding.languageKey: field.empty',
    ]);
    // Opaque on purpose: nothing here resolves a language against a registry that is not seeded yet.
    expect(problemsOf({ boxes: [textBox({ binding: { ...LYRIC_BINDING, languageKey: 'not-a-language' } })] })).toEqual([]);
  });

  it('refuses a Text box nobody bound anything to, the way it refuses a box nobody positioned', () => {
    expect(problemsOf({ boxes: [textBox({ binding: undefined })] })).toEqual(['layout.boxes.0.binding: field.required']);
    expect(problemsOf({ boxes: [textBox({ binding: 'lyricLine' })] })).toEqual([
      'layout.boxes.0.binding: field.not_an_object',
    ]);
    expect(problemsOf({ boxes: [textBox({ binding: { ...LYRIC_BINDING, mode: 'inherited' } })] })).toEqual([
      'layout.boxes.0.binding.mode: field.not_allowed',
    ]);
  });

  it('carries the fixed words of a static box, and reads no key or language on one', () => {
    expect(bindingOf({ boxes: [textBox({ binding: { mode: 'static', text: 'Welcome' } })] })).toEqual({
      mode: 'static',
      text: 'Welcome',
    });
    // Everything a keyed binding would have been refused for, on a static one, read by nothing.
    const cluttered = { mode: 'static', text: 'Welcome', contentKind: 'liturgy', contentKey: 'chorus', languageKey: '' };
    expect(problemsOf({ boxes: [textBox({ binding: cluttered })] })).toEqual([]);
    expect(bindingOf({ boxes: [textBox({ binding: cluttered })] })).toEqual({ mode: 'static', text: 'Welcome' });
  });

  it('refuses a static box with nothing to say', () => {
    expect(problemsOf({ boxes: [textBox({ binding: { mode: 'static' } })] })).toEqual([
      'layout.boxes.0.binding.text: field.required',
    ]);
    expect(problemsOf({ boxes: [textBox({ binding: { mode: 'static', text: '' } })] })).toEqual([
      'layout.boxes.0.binding.text: field.empty',
    ]);
  });

  // Binding is what a Text box says, and a Media box says nothing: no task has asked for one yet, and a
  // Media box asked for a content key it cannot use would be a refusal nobody could act on.
  it('asks a Media box for no binding at all, and reads none if one is there', () => {
    expect(problemsOf({ boxes: [mediaBox()] })).toEqual([]);
    expect(fieldsOf({ boxes: [mediaBox({ binding: { ...LYRIC_BINDING } })] })).not.toContain('binding');
  });

  it('keeps a Layout of keyed and static boxes byte-identical across a save and a read', () => {
    const boxes = [
      mediaBox(),
      textBox({ id: 'lyric' }),
      textBox({ id: 'title', binding: { mode: 'keyed', contentKind: 'sermon', contentKey: 'title', languageKey: 'en' } }),
      textBox({ id: 'welcome', binding: { mode: 'static', text: 'Welcome' } }),
    ];
    const parsed = parseSlideLayoutBody({ boxes });
    expect(parsed).toEqual({ ok: true, value: { boxes } });
    expect(parsed.ok && canonicalJson(parsed.value)).toBe(canonicalJson({ boxes }));
  });
});

// TMPL-03 asks for Slide Layouts that "remain background-transparent". The way that is kept here is by
// having nothing to keep: no box, no style and no Layout carries a fill of its own, so whatever a group
// puts behind a slide is what shows through wherever a box does not cover. A field added later would be
// the moment the promise broke, so it is asserted in the types as well as on a value.
type Fill = `background${string}` | `fill${string}` | `backdrop${string}`;

type Transparent<T> = [Extract<keyof T, Fill>] extends [never] ? true : false;

const TRANSPARENT: readonly boolean[] = [
  true satisfies Transparent<SlideLayoutBody>,
  true satisfies Transparent<TextLayoutBox>,
  true satisfies Transparent<MediaLayoutBox>,
  true satisfies Transparent<TextBoxStyle>,
  true satisfies Transparent<MediaBoxStyle>,
  true satisfies Transparent<BoxFrame>,
];

/** Every field name anywhere in a value, however deeply nested. */
const namesIn = (value: unknown): readonly string[] =>
  Array.isArray(value)
    ? value.flatMap(namesIn)
    : typeof value === 'object' && value !== null
      ? Object.entries(value).flatMap(([name, held]) => [name, ...namesIn(held)])
      : [];

describe('a Slide Layout the group background shows through', () => {
  it('carries no fill of its own, in its types or on a Layout built from every kind of box', () => {
    expect(TRANSPARENT).toEqual([true, true, true, true, true, true]);
    const parsed = parseSlideLayoutBody({
      boxes: [mediaBox(), textBox(), textBox({ id: 'welcome', binding: { mode: 'static', text: 'Welcome' } })],
    });
    expect(parsed.ok).toBe(true);
    const fills = parsed.ok ? namesIn(parsed.value).filter((name) => /^(?:background|fill|backdrop)/iu.test(name)) : [];
    expect(fills).toEqual([]);
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
