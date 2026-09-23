// The domain payloads a service is written in: the service itself, its ordered sections, the items in
// them, and the references by which an item pins one immutable revision of reusable content.

import { aspectRatioOf, parseSafeAreaMargins, type SafeAreaMargins } from './snapshots.js';
import { parseBoxFrame, parseTextBoxStyle, type BoxFrame, type TextBoxStyle } from './layouts.js';
import { FIELD_CODES, type FieldReader, type ParseFn, type Parsed, parseObject } from './problems.js';

export const SERVICE_STATES = ['upcoming', 'presenting', 'completed', 'archived'] as const;
export type ServiceState = (typeof SERVICE_STATES)[number];

/** The words the product calls each state by. The wire carries the code; people read the label. */
export const SERVICE_STATE_LABELS: Record<ServiceState, string> = {
  upcoming: 'Upcoming',
  presenting: 'Presenting',
  completed: 'Completed',
  archived: 'Archived',
};

// ADR 0002: the lifecycle advances one canonical step at a time and never runs backward;
// Archived is terminal. Named once here so the store's transition guard — and T74/T79, which
// enforce the ADR's other two invariants — read the same table instead of re-deriving it.
const NEXT_STATE: Readonly<Record<ServiceState, ServiceState | undefined>> = {
  upcoming: 'presenting',
  presenting: 'completed',
  completed: 'archived',
  archived: undefined,
};

/** Whether `to` is the single next step in ADR 0002's canonical lifecycle after `from`. */
export const isCanonicalTransition = (from: ServiceState, to: ServiceState): boolean =>
  NEXT_STATE[from] === to;

/** ADR 0002 / SERV-03: join access follows Presenting alone. */
export const joinAllowedFor = (state: ServiceState): boolean => state === 'presenting';

export const ITEM_KINDS = ['song', 'sermon', 'reading', 'media', 'slide-group', 'custom-slide'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** The one kind of item that carries its own slides instead of referencing reusable content. */
const AUTHORED_IN_PLACE: ItemKind = 'custom-slide';

export type RevisionRef = {
  readonly id: string;
  readonly revision: number;
  readonly hash: string | undefined;
};

/** The ways custom media can occupy its slide box. */
export const CUSTOM_MEDIA_FITS = ['original', 'contain', 'cover', 'stretch'] as const;

/** A renderer-supported fit for media placed directly on a custom slide. */
export type CustomMediaFit = (typeof CUSTOM_MEDIA_FITS)[number];

/** A text or media box authored directly in a custom slide's normalized canvas. */
export type CustomSlideBox =
  | {
    readonly id: string;
    readonly kind: 'text';
    readonly frame: BoxFrame;
    readonly layer: number;
    readonly text: string;
    readonly style: TextBoxStyle;
  }
  | {
    readonly id: string;
    readonly kind: 'media';
    readonly frame: BoxFrame;
    readonly layer: number;
    readonly mediaId: string;
    readonly mediaKind: 'image' | 'video';
    readonly fit: CustomMediaFit;
    readonly intrinsicSize: { readonly width: number; readonly height: number };
  };

/** The passage and optional layout selected for a reading placed in a service. */
export type ReadingBody = {
  readonly kind: 'reading';
  readonly translation: string;
  readonly compare: readonly string[];
  readonly book: string;
  readonly chapter: number;
  readonly verses: string;
  readonly slideLayout?: { readonly id: string; readonly revision: number };
};

/** The canvas held by a custom slide service item. */
export type CustomSlideBody = {
  readonly kind: 'custom-slide';
  readonly background?: string;
  readonly boxes: readonly CustomSlideBox[];
};

/** The inline item payloads that have no reusable content revision of their own. */
export type ServiceItemBody = CustomSlideBody | ReadingBody;

export type ServiceItem = {
  readonly id: string;
  readonly kind: ItemKind;
  readonly title: string;
  readonly enabled: boolean;
  readonly content: RevisionRef | undefined;
  readonly body?: ServiceItemBody;
};

export type ServiceSection = {
  readonly id: string;
  readonly name: string;
  readonly items: readonly ServiceItem[];
};

export type Service = {
  readonly id: string;
  readonly title: string;
  readonly date: string;
  readonly site: string;
  readonly state: ServiceState;
  readonly sections: readonly ServiceSection[];
  readonly output?: ServiceOutput;
};

/** WS-11: a service may override the administrative output ratio and safe area; items never can. */
export type ServiceOutput = {
  readonly aspectRatio?: string;
  readonly safeAreaMargins?: SafeAreaMargins;
};

/** Reads the output profile overrides carried by a service. */
export function parseServiceOutput(value: unknown): Parsed<ServiceOutput> {
  return parseObject(value, 'output', (reader) => {
    const aspectRatio = reader.optionalText('aspectRatio');
    if (aspectRatio !== undefined) {
      const ratio = aspectRatioOf(aspectRatio);
      const shape = ratio === undefined ? Number.NaN : ratio.width / ratio.height;
      if (!(shape >= 0.25 && shape <= 4)) {
        reader.reject('aspectRatio', FIELD_CODES.notAllowed, 'must be a ratio such as 16:9, between 1:4 and 4:1');
      }
    }
    const safeAreaMargins = reader.optionalParsed('safeAreaMargins', parseSafeAreaMargins);
    return {
      ...(aspectRatio === undefined ? {} : { aspectRatio }),
      ...(safeAreaMargins === undefined ? {} : { safeAreaMargins }),
    };
  });
}

/** A new Service: everything `create` needs, before it has an id or has ever changed state. */
export type ServiceDraft = {
  readonly title: string;
  readonly date: string;
  readonly site: string;
  readonly sections: readonly ServiceSection[];
};

// A digest names the algorithm that produced it, so a stored hash stays readable when the algorithm
// changes and two digests of different algorithms can never be compared as if they were the same thing.
const HASH = /^[a-z][a-z0-9]*-[0-9a-f]{8,64}$/u;

const DAY = /^\d{4}-\d{2}-\d{2}$/u;

// A service is dated by the day it is held on, not by an instant, and the day has to exist: the built-in
// parser rolls a 31st of September over into October rather than refusing it, so the day is read back.
export const isCalendarDay = (value: string): boolean => {
  if (!DAY.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().startsWith(value);
};

export const parseRevisionRef: ParseFn<RevisionRef> = (value, path) =>
  parseObject(value, path, (reader) => {
    const hash = reader.optionalText('hash');
    if (hash !== undefined && !HASH.test(hash)) {
      reader.reject('hash', FIELD_CODES.notAllowed, 'must name the algorithm that produced it, such as fnv1a-6fe1d1e9');
    }
    return { id: reader.text('id'), revision: reader.wholeNumber('revision', 1), hash };
  });

const VERSES = /^\d+(-\d+)?(,\d+(-\d+)?)*$/u;

const customSlideBoxParser: ParseFn<CustomSlideBox> = (value, path) =>
  parseObject(value, path, (reader) => {
    const id = reader.text('id');
    const kind = reader.choice('kind', ['text', 'media'] as const);
    const fields = { id, kind, frame: reader.parsed('frame', parseBoxFrame, { x: 0, y: 0, width: 1, height: 1 }), layer: reader.wholeNumber('layer') };
    if (kind === 'text') {
      return { ...fields, kind, text: reader.text('text'), style: reader.parsed('style', parseTextBoxStyle, { fontFamily: '', fontWeight: 100, sizeRatio: 0, lineHeight: 1, align: 'start', verticalAlign: 'start' }) };
    }
    return {
      ...fields,
      kind,
      mediaId: reader.text('mediaId'),
      mediaKind: reader.choice('mediaKind', ['image', 'video'] as const),
      fit: reader.choice('fit', CUSTOM_MEDIA_FITS),
      intrinsicSize: reader.parsed('intrinsicSize', (raw, at) => parseObject(raw, at, (size) => ({ width: size.wholeNumber('width', 1), height: size.wholeNumber('height', 1) })), { width: 1, height: 1 }),
    };
  });

const customSlideBody = (reader: FieldReader): CustomSlideBody => {
  const boxes = reader.parsedList('boxes', customSlideBoxParser);
  if (new Set(boxes.map((box) => box.id)).size !== boxes.length) {
    reader.reject('boxes', FIELD_CODES.notAllowed, 'must not hold two boxes with the same id');
  }
  const background = reader.optionalText('background');
  return { kind: 'custom-slide', boxes, ...(background === undefined ? {} : { background }) };
};

const readingBody = (reader: FieldReader): ReadingBody => {
  const compare = reader.textList('compare');
  if (compare.length > 3) reader.reject('compare', FIELD_CODES.notAllowed, 'must hold at most three translations');
  const verses = reader.text('verses');
  if (verses !== '' && !VERSES.test(verses)) reader.reject('verses', FIELD_CODES.notAllowed, 'must be verse numbers such as 1-5 or 3');
  const slideLayout = reader.optionalParsed('slideLayout', (raw, at) => parseObject(raw, at, (layout) => ({ id: layout.text('id'), revision: layout.wholeNumber('revision', 1) })));
  return { kind: 'reading', translation: reader.text('translation'), compare, book: reader.text('book'), chapter: reader.wholeNumber('chapter', 1), verses, ...(slideLayout === undefined ? {} : { slideLayout }) };
};

/** Reads an inline custom-slide canvas or a reading passage carried by a service item. */
export function parseServiceItemBody(value: unknown): Parsed<ServiceItemBody> {
  return parseObject(value, 'item.body', (reader) => {
    const kind = reader.choice('kind', ['custom-slide', 'reading'] as const);
    return kind === 'custom-slide' ? customSlideBody(reader) : readingBody(reader);
  });
}

const itemParser = (seenItems: Set<string>): ParseFn<ServiceItem> => (value, path) =>
  parseObject(value, path, (reader) => {
    const id = reader.text('id');
    if (id !== '' && seenItems.has(id)) {
      reader.reject('id', FIELD_CODES.notAllowed, 'must not repeat an item already in this service');
    }
    seenItems.add(id);
    const kind = reader.choice('kind', ITEM_KINDS);
    const title = reader.text('title');
    const enabled = reader.optionalFlag('enabled') ?? true;
    // Reusable content is pinned to an explicit revision; a custom slide has no reusable content to pin,
    // and one that claims to would leave two sources for what a slide shows.
    if (kind === AUTHORED_IN_PLACE) {
      reader.absent('content', FIELD_CODES.notAllowed, 'must not be pinned by a custom slide');
    }
    if (kind === 'reading') {
      reader.absent('content', FIELD_CODES.notAllowed, 'must not be pinned by a reading');
    }
    const content = kind === AUTHORED_IN_PLACE || kind === 'reading'
      ? undefined
      : reader.parsed('content', parseRevisionRef, undefined);
    if (kind !== 'custom-slide' && kind !== 'reading') {
      reader.absent('body', FIELD_CODES.notAllowed, 'must only be set on a custom slide or reading');
    }
    const body = reader.optionalParsed('body', parseServiceItemBody);
    if (body !== undefined && body.kind !== kind) {
      reader.reject('body.kind', FIELD_CODES.notAllowed, 'must match the item kind');
    }
    return { id, kind, title, enabled, content, ...(body === undefined ? {} : { body }) };
  });

const sectionParser = (seenSections: Set<string>, seenItems: Set<string>): ParseFn<ServiceSection> =>
  (value, path) =>
    parseObject(value, path, (reader) => {
      const id = reader.text('id');
      if (id !== '' && seenSections.has(id)) {
        reader.reject('id', FIELD_CODES.notAllowed, 'must not repeat a section already in this service');
      }
      seenSections.add(id);
      return { id, name: reader.text('name'), items: reader.parsedList('items', itemParser(seenItems)) };
    });

const eventFields = (reader: FieldReader): Omit<ServiceDraft, 'sections'> => {
  const title = reader.text('title');
  const date = reader.text('date');
  if (date !== '' && !isCalendarDay(date)) {
    reader.reject('date', FIELD_CODES.notAllowed, 'must be a calendar day such as 2026-09-13');
  }
  return { title, date, site: reader.text('site') };
};

const draftFields = (reader: FieldReader): ServiceDraft => ({
  ...eventFields(reader),
  sections: reader.parsedList('sections', sectionParser(new Set(), new Set())),
});

export function parseServiceItem(value: unknown): Parsed<ServiceItem> {
  return itemParser(new Set())(value, 'item');
}

export function parseServiceSchedule(value: unknown): Parsed<{ date: string }> {
  return parseObject(value, 'service', (reader) => ({ date: reader.text('date') }));
}

export function parseServiceTransition(value: unknown): Parsed<{ state: ServiceState }> {
  return parseObject(value, 'service', (reader) => ({
    state: reader.choice('state', SERVICE_STATES),
  }));
}

export function parseServiceStatus(value: unknown): Parsed<{ archived: boolean }> {
  return parseObject(value, 'service', (reader) => ({ archived: reader.flag('archived') }));
}

export function parseServiceItemReorder(value: unknown): Parsed<{ itemIds: readonly string[] }> {
  return parseObject(value, 'service', (reader) => ({ itemIds: reader.textList('itemIds') }));
}

export function parseServiceItemRevision(value: unknown): Parsed<{ revision: number }> {
  return parseObject(value, 'service', (reader) => ({ revision: reader.wholeNumber('revision') }));
}

export function parseServiceDraft(value: unknown): Parsed<ServiceDraft> {
  return parseObject(value, 'service', draftFields);
}

export function parseService(value: unknown): Parsed<Service> {
  return parseObject(value, 'service', (reader) => ({
    id: reader.text('id'),
    ...eventFields(reader),
    state: reader.choice('state', SERVICE_STATES),
    sections: reader.parsedList('sections', sectionParser(new Set(), new Set())),
    output: reader.optionalParsed('output', parseServiceOutput),
  }));
}
