// What a Slide Layout is made of: positioned boxes, and the little each kind of box is styled by.
//
// TMPL-01 asks for Layouts "built from positioned Text and Media boxes with geometry and styles", and the
// word doing the work is *positioned*: a box whose frame is missing a side is not a box placed loosely, it
// is a box nobody placed, and this file refuses it rather than defaulting it onto the slide. The refusal
// names the side, because the person who has to fix it is looking at one box out of several.
//
// Geometry is normalized, in the same vocabulary `@holydeck/renderer`'s own model uses: a frame is a
// fraction of the slide and a type size is a fraction of the canvas height, so nothing authored here knows
// what a pixel is and one Layout lands identically on a 320px thumbnail and a wall. That alignment is the
// reason this lives in the contracts rather than beside its routes — the renderer, the application and
// whatever admin surface arrives later all have to agree what a frame means, and none of them may own it.
//
// What a Text box says and what language it says it in is its binding (TMPL-03). A box is bound one of
// two ways and never both: keyed, to one named field of one kind of content in one named language, so a
// Layout is a shape songs and sermons are poured into rather than a slide with words in it; or static,
// to words the Layout itself holds, for the box that says "Welcome" on every service of the year. A
// Media box binds nothing yet and carries the opaque stand-in a Text box no longer needs — a file name,
// a note to whoever fills it.
//
// The keys are a closed vocabulary here rather than live data on purpose: what a song has is a property
// of what a song is, and a Layout authored against a key that later stops existing is a Layout that
// breaks silently. The language key is the opposite — an opaque string, checked for being there and
// nothing else, because the registry it names (§11.5) has nothing in it until SEED-01 seeds it.
//
// Nothing here carries a fill, a colour or a background, and that absence is the whole of TMPL-03's
// "Slide Layouts remain background-transparent": a Layout has no ground of its own to paint, so what a
// group puts behind a slide is what shows through wherever no box covers.

import {
  FIELD_CODES,
  type FieldReader,
  type Parsed,
  type ParseFn,
  type Range,
  parseObject,
} from './problems.js';

/** Where Slide Layouts are administered. Here rather than beside the routes, for the reason above. */
export const SLIDE_LAYOUTS_PATH = '/api/v1/slide-layouts';

/** The two kinds of box a Layout is built from. A third arrives when a requirement asks for one. */
export const BOX_KINDS = ['text', 'media'] as const;

export type BoxKind = (typeof BOX_KINDS)[number];

/** How the renderer grades a box against the safe area: required content blocks, decoration warns. */
export const BOX_IMPORTANCES = ['required', 'decoration'] as const;

export type BoxImportance = (typeof BOX_IMPORTANCES)[number];

export const TEXT_ALIGNMENTS = ['start', 'center', 'end'] as const;

export type TextAlignment = (typeof TEXT_ALIGNMENTS)[number];

/** How a picture or a still fills the box it is given: whole and letterboxed, or filling and cropped. */
export const MEDIA_FITS = ['contain', 'cover'] as const;

export type MediaFit = (typeof MEDIA_FITS)[number];

/** The two ways a Text box is given something to say. A box is bound one way, never both. */
export const BINDING_MODES = ['keyed', 'static'] as const;

export type BindingMode = (typeof BINDING_MODES)[number];

/** The kinds of content a Layout is authored against. A fourth arrives when a requirement asks for one. */
export const CONTENT_KINDS = ['song', 'sermon', 'reading'] as const;

export type ContentKind = (typeof CONTENT_KINDS)[number];

// One entry per kind, and the list is closed for the reason in the header: these are the fields a song
// or a sermon has, not rows somebody can add to. A key is added here when the content it names exists.
export const CONTENT_KEYS: Readonly<Record<ContentKind, readonly string[]>> = Object.freeze({
  song: Object.freeze(['title', 'lyricLine', 'author', 'copyright']),
  sermon: Object.freeze(['title', 'point', 'scriptureRef', 'speaker']),
  reading: Object.freeze(['reference', 'verseText', 'translation']),
});

/** A box filled from content: one field of one kind, in one language of that content's own list. */
export type KeyedBinding = {
  readonly mode: 'keyed';
  readonly contentKind: ContentKind;
  readonly contentKey: string;
  /**
   * Which language of the content fills this box. Opaque here: the registry §11.5 describes is seeded
   * by SEED-01, and until then there is nothing to resolve a key against but its own presence.
   */
  readonly languageKey: string;
};

/** A box the Layout itself fills: the words are the Layout's, and no content is read for it. */
export type StaticBinding = {
  readonly mode: 'static';
  readonly text: string;
};

export type BoxBinding = KeyedBinding | StaticBinding;

/** The weights a face is asked for, as CSS numbers them. Neither end is a weight any face refuses. */
export const FONT_WEIGHT: Range = Object.freeze({ minimum: 100, maximum: 900 });

/** Leading, as a multiple of the type size. One is set solid; four is as loose as a slide ever wants. */
export const LINE_HEIGHT: Range = Object.freeze({ minimum: 1, maximum: 4 });

/** Long enough to tell two Layouts apart in a list, short enough to show one without wrapping. */
export const LAYOUT_NAME = Object.freeze({ minimum: 1, maximum: 64 });

// Frames are authored by dragging a box to an edge, and an edge reached by adding two fractions lands a
// hair past it about as often as it lands on it. A tolerance of a billionth of a slide is smaller than any
// display has pixels for, and it is the difference between "snapped to the edge" and a refusal nobody can
// act on.
const EDGE_TOLERANCE = 1e-9;

/** Fractions of the slide the box sits on: `{ x: 0.1, width: 0.8 }` is a box inset a tenth on each side. */
export type BoxFrame = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type TextBoxStyle = {
  readonly fontFamily: string;
  readonly fontWeight: number;
  /** Requested size as a fraction of the canvas height, before the renderer's auto-fit reduces it. */
  readonly sizeRatio: number;
  readonly lineHeight: number;
  readonly align: TextAlignment;
  readonly verticalAlign: TextAlignment;
};

export type MediaBoxStyle = {
  readonly fit: MediaFit;
  readonly opacity: number;
};

type BoxFields = {
  readonly id: string;
  readonly frame: BoxFrame;
  readonly importance: BoxImportance;
};

export type TextLayoutBox = BoxFields & {
  readonly kind: 'text';
  /** What this box says. Required: a Text box nobody bound is a box with nothing in it at all. */
  readonly binding: BoxBinding;
  readonly style: TextBoxStyle;
};

export type MediaLayoutBox = BoxFields & {
  readonly kind: 'media';
  readonly style: MediaBoxStyle;
  /**
   * What stands in for the asset until one is bound to this box: a file name, a note to whoever fills
   * it. Opaque on purpose — nothing reads it as a content or a language key. No requirement has asked
   * for Media binding yet, which is why this is still what a Media box carries.
   */
  readonly placeholder?: string;
};

export type LayoutBox = TextLayoutBox | MediaLayoutBox;

/**
 * The whole of what a Slide Layout's content is, and exactly what is appended to its revision history.
 * A type alias rather than an interface, because this is handed to the revision store as a body — which is
 * a plain record of unknown values, and only a type alias is assignable to one.
 */
export type SlideLayoutBody = {
  readonly boxes: readonly LayoutBox[];
};

/** A new Slide Layout: the name it is administered under, and the boxes it starts life holding. */
export type SlideLayoutDraft = {
  readonly name: string;
  readonly body: SlideLayoutBody;
};

/** Whether a Layout is being hidden from where Layouts are chosen, or brought back to it. */
export type SlideLayoutStatus = {
  readonly archived: boolean;
};

/** What a frame side of none is refused with: the rule is about the slide, and so is the sentence. */
const NO_ROOM = 'must leave some of the slide to draw in';

/** What a type size of none is refused with. The same rule, about type rather than about the slide. */
const NO_TYPE = 'must be a size type can be read at';

/**
 * A fraction that has to leave something behind: a box a slide wide is a box, a box no wide is not one.
 * The extra rule is applied only when the field itself was read, so a missing width is reported once.
 * What the fraction is a fraction of decides the sentence, because a font size answered with a complaint
 * about the slide sends whoever has to fix it to look at the frame.
 */
const extent = (reader: FieldReader, name: string, refusal: string): number => {
  const before = reader.problems.length;
  const value = reader.ratio(name);
  if (reader.problems.length === before && value === 0) {
    reader.reject(name, FIELD_CODES.tooSmall, refusal);
  }
  return value;
};

export const parseBoxFrame: ParseFn<BoxFrame> = (value, path) =>
  parseObject(value, path, (reader) => {
    const before = reader.problems.length;
    const frame = {
      x: reader.ratio('x'),
      y: reader.ratio('y'),
      width: extent(reader, 'width', NO_ROOM),
      height: extent(reader, 'height', NO_ROOM),
    };
    // Only when all four were read: a box whose width is missing has not also been placed past the edge.
    if (reader.problems.length === before) {
      if (frame.x + frame.width > 1 + EDGE_TOLERANCE) {
        reader.reject('width', FIELD_CODES.tooLarge, 'must not reach past the right edge of the slide');
      }
      if (frame.y + frame.height > 1 + EDGE_TOLERANCE) {
        reader.reject('height', FIELD_CODES.tooLarge, 'must not reach past the bottom edge of the slide');
      }
    }
    return frame;
  });

const FRAME_FALLBACK: BoxFrame = { x: 0, y: 0, width: 1, height: 1 };

/**
 * The content field a box is filled from. Graded against the keys its own kind offers, and only when the
 * kind was one this release has: a key held against whichever kind happened to be first would answer a
 * question nobody asked. A key that was missing or was not text is left at that, for the same reason a
 * missing width is not also reported as reaching past the edge of the slide.
 */
const boundKey = (reader: FieldReader, kind: ContentKind | undefined): string => {
  const before = reader.problems.length;
  const key = reader.text('contentKey');
  if (kind === undefined || reader.problems.length > before) return key;
  const offered = CONTENT_KEYS[kind];
  if (!offered.includes(key)) {
    reader.reject('contentKey', FIELD_CODES.notAllowed, `must be one of ${offered.join(', ')}`);
  }
  return key;
};

const keyed = (reader: FieldReader): KeyedBinding => {
  const before = reader.problems.length;
  const contentKind = reader.choice('contentKind', CONTENT_KINDS);
  const known = reader.problems.length === before;
  return {
    mode: 'keyed',
    contentKind,
    contentKey: boundKey(reader, known ? contentKind : undefined),
    // Present and non-empty, and nothing further: §11.5's registry is SEED-01's to fill, and a key is
    // refused here for being absent rather than for naming a language nobody has added yet.
    languageKey: reader.text('languageKey'),
  };
};

const BINDING_FALLBACK: BoxBinding = { mode: 'static', text: '' };

export const parseBoxBinding: ParseFn<BoxBinding> = (value, path) =>
  parseObject(value, path, (reader) => {
    const before = reader.problems.length;
    const mode = reader.choice('mode', BINDING_MODES);
    // A binding bound a way this release does not have is one whose other fields it cannot read either:
    // which of them belong is exactly what the mode decides.
    if (reader.problems.length > before) return BINDING_FALLBACK;
    // Otherwise the mode decides what is read, and a static box is never asked for a key or a language.
    return mode === 'static' ? { mode, text: reader.text('text') } : keyed(reader);
  });

const parseTextBoxStyle: ParseFn<TextBoxStyle> = (value, path) =>
  parseObject(value, path, (reader) => ({
    fontFamily: reader.text('fontFamily'),
    fontWeight: weight(reader),
    sizeRatio: extent(reader, 'sizeRatio', NO_TYPE),
    lineHeight: reader.ratio('lineHeight', LINE_HEIGHT),
    align: reader.choice('align', TEXT_ALIGNMENTS),
    verticalAlign: reader.choice('verticalAlign', TEXT_ALIGNMENTS),
  }));

const weight = (reader: FieldReader): number => {
  const value = reader.wholeNumber('fontWeight', FONT_WEIGHT.minimum);
  if (value > FONT_WEIGHT.maximum) {
    reader.reject('fontWeight', FIELD_CODES.tooLarge, `must be at most ${FONT_WEIGHT.maximum}`);
  }
  return value;
};

const TEXT_STYLE_FALLBACK: TextBoxStyle = {
  fontFamily: '',
  fontWeight: FONT_WEIGHT.minimum,
  sizeRatio: 0,
  lineHeight: LINE_HEIGHT.minimum,
  align: 'start',
  verticalAlign: 'start',
};

const parseMediaBoxStyle: ParseFn<MediaBoxStyle> = (value, path) =>
  parseObject(value, path, (reader) => ({
    fit: reader.choice('fit', MEDIA_FITS),
    opacity: reader.ratio('opacity'),
  }));

const MEDIA_STYLE_FALLBACK: MediaBoxStyle = { fit: 'contain', opacity: 1 };

export const parseLayoutBox: ParseFn<LayoutBox> = (value, path) =>
  parseObject(value, path, (reader) => {
    const id = reader.text('id');
    const before = reader.problems.length;
    const kind = reader.choice('kind', BOX_KINDS);
    const known = reader.problems.length === before;
    const fields = {
      id,
      frame: reader.parsed('frame', parseBoxFrame, FRAME_FALLBACK),
      importance: reader.choice('importance', BOX_IMPORTANCES),
    };
    // A box of a kind this release does not have is a box whose style it cannot grade either. Its style is
    // required and left at that: six complaints about type on a box that was never a Text box help nobody.
    // Nor is it asked for a binding, which only one of the two kinds has.
    if (!known) {
      reader.present('style');
      return { ...fields, kind: 'text', binding: BINDING_FALLBACK, style: TEXT_STYLE_FALLBACK };
    }
    // Otherwise the kind decides what is read, so a Media box is never graded against type it has none of,
    // and a Text box is never left carrying a stand-in beside the binding that supersedes it.
    return kind === 'media'
      ? {
          ...fields,
          kind,
          style: reader.parsed('style', parseMediaBoxStyle, MEDIA_STYLE_FALLBACK),
          ...optional('placeholder', reader.optionalText('placeholder')),
        }
      : {
          ...fields,
          kind,
          binding: reader.parsed('binding', parseBoxBinding, BINDING_FALLBACK),
          style: reader.parsed('style', parseTextBoxStyle, TEXT_STYLE_FALLBACK),
        };
  });

const optional = (name: string, value: string | undefined): Record<string, string> =>
  value === undefined ? {} : { [name]: value };

/** The first identifier two boxes share, or nothing when every box has one of its own. */
const repeated = (boxes: readonly LayoutBox[]): string | undefined => {
  const seen = new Set<string>();
  for (const box of boxes) {
    if (seen.has(box.id)) return box.id;
    seen.add(box.id);
  }
  return undefined;
};

const readBoxes = (reader: FieldReader): readonly LayoutBox[] => {
  const before = reader.problems.length;
  const boxes = reader.parsedList('boxes', parseLayoutBox);
  // Rules about the list as a whole, asked only of a list every box of which was read: "there are none"
  // is not worth saying about a list whose only box was refused a moment ago.
  if (reader.problems.length > before) return boxes;
  if (boxes.length === 0) reader.reject('boxes', FIELD_CODES.empty, 'must hold at least one box');
  const twice = repeated(boxes);
  if (twice !== undefined) {
    reader.reject('boxes', FIELD_CODES.notAllowed, `must not hold two boxes named ${twice}`);
  }
  return boxes;
};

const readName = (reader: FieldReader): string => {
  const name = reader.text('name');
  if (name.length > LAYOUT_NAME.maximum) {
    reader.reject('name', FIELD_CODES.tooLarge, `must be at most ${LAYOUT_NAME.maximum} characters`);
  }
  return name;
};

/** Reads the boxes a Slide Layout is built from, or every reason they are not a Layout. */
export function parseSlideLayoutBody(value: unknown): Parsed<SlideLayoutBody> {
  return parseObject(value, 'layout', (reader) => ({ boxes: readBoxes(reader) }));
}

export function parseSlideLayoutDraft(value: unknown): Parsed<SlideLayoutDraft> {
  return parseObject(value, 'layout', (reader) => ({
    name: readName(reader),
    body: { boxes: readBoxes(reader) },
  }));
}

export function parseSlideLayoutStatus(value: unknown): Parsed<SlideLayoutStatus> {
  return parseObject(value, 'layout', (reader) => ({ archived: reader.flag('archived') }));
}
