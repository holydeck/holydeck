// What a slide group or a reusable slide holds (spec SLID-01), saved as a content revision body
// through the already-generic `revisionsOn()` store. Neither entity stamp — `reusableSlide` nor
// `slideGroup` — is minted here: `@holydeck/contracts/library` already names both kinds, and
// `apps/app/src/library.ts` already mints the `contentId` a body here is saved against. This file
// owns only the shape of that body.
//
// A `Slide`'s content field is deliberately minimal: `label`, free text, and nothing else. SLID-02
// (group background and Slide Layout inheritance) and LANG-01 (ordered multilingual language blocks
// per slide) both reshape a Slide once they land; this task's own lifecycle tests only need some
// field `edit` can change, and naming it durably ahead of either requirement would be a guess this
// file does not make.

import { FIELD_CODES, isRecord, type ParseFn, parseObject } from './problems.js';

/** A single slide: shown or not, and the placeholder content field described above. */
export interface Slide {
  readonly id: string;
  readonly enabled: boolean;
  readonly label: string;
}

/** Whether a group's slides were authored by hand or projected from pinned inputs. */
export const SLIDE_GROUP_MODES = ['custom', 'generated'] as const;

export type SlideGroupMode = (typeof SLIDE_GROUP_MODES)[number];

/**
 * What a slide group — or a reusable slide's one-`Slide` group — holds. `enabled` is the group's own
 * show/hide flag, alongside each slide's own.
 */
export interface SlideGroupBody {
  readonly mode: SlideGroupMode;
  readonly enabled: boolean;
  /**
   * Present only when `mode === 'generated'`. Opaque here — the shape a concrete generator (T51
   * songs, later sermon/general projections) pins is that generator's to define; this file only
   * carries it forward unread.
   */
  readonly generatedFrom?: Readonly<Record<string, unknown>>;
  readonly slides: readonly Slide[];
}

export const parseSlide: ParseFn<Slide> = (value, path) =>
  parseObject(value, path, (reader) => ({
    id: reader.text('id'),
    enabled: reader.flag('enabled'),
    label: reader.text('label'),
  }));

/** Opaque and unvalidated beyond "is an object": this file only carries it forward, never reads it. */
const parseOpaqueRecord: ParseFn<Readonly<Record<string, unknown>>> = (value, path) =>
  isRecord(value)
    ? { ok: true, value }
    : { ok: false, problems: [{ path, code: FIELD_CODES.notAnObject, message: 'must be an object' }] };

export const parseSlideGroupBody: ParseFn<SlideGroupBody> = (value, path) =>
  parseObject(value, path, (reader) => {
    const mode = reader.choice('mode', SLIDE_GROUP_MODES);
    const enabled = reader.flag('enabled');
    const slides = reader.parsedList('slides', parseSlide);
    const generatedFrom = reader.optionalParsed('generatedFrom', parseOpaqueRecord);
    return { mode, enabled, slides, ...(generatedFrom === undefined ? {} : { generatedFrom }) };
  });
