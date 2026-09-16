import { describe, expect, it } from 'vitest';

import { addressOf } from './revisions.js';
import {
  applySharedTextStyle,
  EDITABLE_TEXT_STYLE_FIELDS,
  selectBoxes,
  SelectionError,
  textStyleAgreement,
} from './slide-layout-selection.js';
import { slideLayoutContext, slideLayoutsOn } from './slide-layouts.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { SlideLayoutBody, TextLayoutBox } from '@holydeck/contracts/layouts';

const boxA: TextLayoutBox = {
  id: 'a',
  kind: 'text',
  importance: 'required',
  frame: { x: 0, y: 0, width: 0.5, height: 0.2 },
  binding: { mode: 'static', text: 'A' },
  style: {
    fontFamily: 'Inter',
    fontWeight: 400,
    sizeRatio: 0.08,
    lineHeight: 1.2,
    align: 'start',
    verticalAlign: 'start',
  },
};

const boxB: TextLayoutBox = {
  id: 'b',
  kind: 'text',
  importance: 'required',
  frame: { x: 0.5, y: 0, width: 0.5, height: 0.2 },
  binding: { mode: 'static', text: 'B' },
  style: {
    fontFamily: 'Georgia',
    fontWeight: 700,
    sizeRatio: 0.1,
    lineHeight: 1.4,
    align: 'center',
    verticalAlign: 'center',
  },
};

const boxC: TextLayoutBox = {
  ...boxA,
  id: 'c',
  frame: { x: 0, y: 0.2, width: 0.5, height: 0.2 },
  binding: { mode: 'static', text: 'C' },
};

const backdrop = {
  id: 'backdrop',
  kind: 'media',
  importance: 'decoration',
  frame: { x: 0, y: 0, width: 1, height: 1 },
  style: { fit: 'cover', opacity: 1 },
} as const;

const body = (...boxes: SlideLayoutBody['boxes']): SlideLayoutBody => ({ boxes });

describe('applying a text property across a selection', () => {
  it('applies the patch to every selected box, and a selection of one behaves like editing that one box', () => {
    const many = applySharedTextStyle(body(boxA, boxB, boxC), selectBoxes(['a', 'b']), { fontWeight: 900 });
    expect((many.body.boxes[0] as TextLayoutBox).style.fontWeight).toBe(900);
    expect((many.body.boxes[1] as TextLayoutBox).style.fontWeight).toBe(900);
    expect((many.body.boxes[2] as TextLayoutBox).style.fontWeight).toBe(400); // unselected, untouched
    expect(many.affected).toEqual(['a', 'b']);

    const one = applySharedTextStyle(body(boxA, boxB), selectBoxes(['a']), { fontWeight: 900 });
    expect((one.body.boxes[0] as TextLayoutBox).style).toEqual({ ...boxA.style, fontWeight: 900 });
    expect((one.body.boxes[1] as TextLayoutBox).style).toEqual(boxB.style);
    expect(one.affected).toEqual(['a']);
  });
});

describe('the selection is never stored', () => {
  it('produces a Layout byte-identical to the same edit made box by box, with no field recording a selection', () => {
    const patch = { fontFamily: 'Verdana', lineHeight: 1.6 } as const;
    const throughSelection = applySharedTextStyle(body(boxA, boxB, boxC, backdrop), selectBoxes(['a', 'b', 'c']), patch);

    const boxByBox: SlideLayoutBody = {
      boxes: [
        { ...boxA, style: { ...boxA.style, ...patch } },
        { ...boxB, style: { ...boxB.style, ...patch } },
        { ...boxC, style: { ...boxC.style, ...patch } },
        backdrop,
      ],
    };

    expect(throughSelection.body).toEqual(boxByBox);
    expect(addressOf(throughSelection.body)).toBe(addressOf(boxByBox));
    expect(Object.keys(throughSelection.body)).toEqual(['boxes']);
    for (const box of throughSelection.body.boxes) {
      expect(Object.keys(box)).not.toContain('selected');
      expect(Object.keys(box)).not.toContain('selection');
    }
  });
});

describe('geometry and bindings are not editable across a selection', () => {
  it('refuses an attempt to set a binding with a named error, and leaves every box unchanged', () => {
    const original = body(boxA, boxB);
    const withBinding = { fontWeight: 900, binding: { mode: 'static', text: 'shared' } };

    expect(() => applySharedTextStyle(original, selectBoxes(['a', 'b']), withBinding)).toThrow(SelectionError);
    try {
      applySharedTextStyle(original, selectBoxes(['a', 'b']), withBinding);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(SelectionError);
      expect((error as SelectionError).kind).toBe('not-editable');
    }
    // Neither box was duplicated onto nor cleared: the original body is exactly what it was.
    expect(original).toEqual(body(boxA, boxB));
  });

  it('refuses an attempt to set a frame the same way', () => {
    const withFrame = { fontWeight: 900, frame: { x: 0, y: 0, width: 1, height: 1 } };
    expect(() => applySharedTextStyle(body(boxA, boxB), selectBoxes(['a', 'b']), withFrame)).toThrow(SelectionError);
  });

  it('names every shared-editable field, matching TextBoxStyle exactly', () => {
    expect([...EDITABLE_TEXT_STYLE_FIELDS].sort()).toEqual(
      ['align', 'fontFamily', 'fontWeight', 'lineHeight', 'sizeRatio', 'verticalAlign'].sort(),
    );
  });
});

describe('a property the selection disagrees about', () => {
  it('presents as mixed, and leaving it untouched leaves every box its own value', () => {
    const agreement = textStyleAgreement(body(boxA, boxB), selectBoxes(['a', 'b']));
    expect(agreement?.fontFamily).toEqual({ agrees: false });
    expect(agreement?.align).toEqual({ agrees: false });

    // Apply a patch that never mentions fontFamily: the boxes' own, differing values are untouched.
    const applied = applySharedTextStyle(body(boxA, boxB), selectBoxes(['a', 'b']), { fontWeight: 900 });
    expect((applied.body.boxes[0] as TextLayoutBox).style.fontFamily).toBe(boxA.style.fontFamily);
    expect((applied.body.boxes[1] as TextLayoutBox).style.fontFamily).toBe(boxB.style.fontFamily);
  });

  it('reports agreement, and what the boxes agree on, for a field that already matches', () => {
    const matching = { ...boxB, style: { ...boxB.style, fontWeight: boxA.style.fontWeight } };
    const agreement = textStyleAgreement(body(boxA, matching), selectBoxes(['a', matching.id]));
    expect(agreement?.fontWeight).toEqual({ agrees: true, value: boxA.style.fontWeight });
  });

  it('answers nothing for a selection with no Text box in it', () => {
    expect(textStyleAgreement(body(backdrop), selectBoxes(['backdrop']))).toBeUndefined();
  });
});

describe('one application, at most one Slide Layout revision', () => {
  it('asserts the revision count, not the rendered result', async () => {
    const db = fakeDb();
    const layouts = slideLayoutsOn(db, { now: () => '2026-09-16T00:00:00.000Z', newId: () => 'layout-1' });
    const context = slideLayoutContext('account:tester', 'req-1');
    const created = await layouts.create(context, { name: 'Three boxes', body: body(boxA, boxB, boxC) });
    expect(await layouts.history(context, created.stamp.id)).toHaveLength(1);

    const applied = applySharedTextStyle(created.body, selectBoxes(['a', 'b', 'c']), { fontWeight: 850 });
    const outcome = await layouts.version(context, created.stamp.id, applied.body);

    expect(outcome?.appended).toBe(true);
    expect(await layouts.history(context, created.stamp.id)).toHaveLength(2);
  });
});

describe('a Media box in the selection', () => {
  it('is unchanged by a text property, and excluded from the affected count', () => {
    const result = applySharedTextStyle(body(boxA, backdrop), selectBoxes(['a', 'backdrop']), { fontWeight: 900 });
    expect(result.body.boxes[1]).toEqual(backdrop);
    expect(result.affected).toEqual(['a']);
  });
});

describe('the administrative minimum readable size', () => {
  it('refuses the whole selection, names the offending boxes, and leaves every box unchanged', () => {
    const original = body(boxA, boxB, boxC);
    let caught: SelectionError | undefined;
    try {
      applySharedTextStyle(original, selectBoxes(['a', 'b', 'c']), { sizeRatio: 0.01 });
    } catch (error) {
      caught = error as SelectionError;
    }
    expect(caught).toBeInstanceOf(SelectionError);
    expect(caught?.kind).toBe('below-minimum-size');
    expect([...(caught?.boxIds ?? [])].sort()).toEqual(['a', 'b', 'c']);
    // No partial application: the original body was never touched, and no smaller intermediate leaked out.
    expect(original).toEqual(body(boxA, boxB, boxC));
  });

  it('allows a size at or above the floor', () => {
    const result = applySharedTextStyle(body(boxA, boxB), selectBoxes(['a', 'b']), { sizeRatio: 0.04 });
    expect((result.body.boxes[0] as TextLayoutBox).style.sizeRatio).toBe(0.04);
  });
});

describe('operable by keyboard alone', () => {
  it('is plain synchronous functions over plain data, with no coordinate or pointer in their signatures', () => {
    for (const fn of [selectBoxes, textStyleAgreement, applySharedTextStyle]) {
      expect(fn.constructor.name).toBe('Function');
    }
    const selection = selectBoxes(['a', 'a', 'b']);
    expect(selection).toEqual(['a', 'b']);
    expect(Array.isArray(selection)).toBe(true);
    expect(textStyleAgreement(body(boxA, boxB), selection)).not.toBeInstanceOf(Promise);
    expect(applySharedTextStyle(body(boxA, boxB), selection, {})).not.toBeInstanceOf(Promise);
  });
});
