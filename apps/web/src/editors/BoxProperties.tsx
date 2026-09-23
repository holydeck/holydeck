// The Properties panel's view of the Custom Slide canvas's selected box: its place and size as whole
// percentages of the slide, its layer, and what its kind adds — type size, weight and alignment for text,
// the fit for media (WS-10). These fields are the keyboard path to everything a pointer does on the
// canvas. A value is taken on change (Enter or leaving the field), clamped inside the slide like every
// other canvas edit, and the field then shows the value that was actually kept.

import { FONT_WEIGHT, TEXT_ALIGNMENTS, type TextAlignment } from '@holydeck/contracts/layouts';
import { CUSTOM_MEDIA_FITS, type CustomMediaFit, type CustomSlideBox } from '@holydeck/contracts/services';
import type { MessageKey } from '@holydeck/localization/messages';
import type { JSX } from 'preact';

import { t } from '../i18n.js';
import { activeCanvas } from './CustomSlideCanvas.js';

type Frame = CustomSlideBox['frame'];
type FrameField = keyof Frame;

const FRAME_FIELDS: readonly { readonly field: FrameField; readonly key: MessageKey; readonly label: MessageKey }[] = [
  { field: 'x', key: 'canvas.x', label: 'canvas.op.move' },
  { field: 'y', key: 'canvas.y', label: 'canvas.op.move' },
  { field: 'width', key: 'canvas.width', label: 'canvas.op.resize' },
  { field: 'height', key: 'canvas.height', label: 'canvas.op.resize' },
];

const FIT_KEYS: Readonly<Record<CustomMediaFit, MessageKey>> = {
  original: 'canvas.fit.original', contain: 'canvas.fit.contain', cover: 'canvas.fit.cover', stretch: 'canvas.fit.stretch',
};

const ALIGN_KEYS: Readonly<Record<TextAlignment, MessageKey>> = {
  start: 'canvas.align.start', center: 'canvas.align.center', end: 'canvas.align.end',
};

const WEIGHTS = Array.from({ length: (FONT_WEIGHT.maximum - FONT_WEIGHT.minimum) / 100 + 1 }, (_, index) => FONT_WEIGHT.minimum + index * 100);

const percent = (ratio: number): number => Math.round(ratio * 10_000) / 100;

/** A number field that commits on change and then shows what the canvas kept. */
function NumberField({ id, label, value, min, max, step, disabled, commit }: {
  readonly id: string; readonly label: string; readonly value: number; readonly min: number; readonly max?: number; readonly step: number;
  readonly disabled: boolean; readonly commit: (next: number) => number | undefined;
}): JSX.Element {
  return (
    <p>
      <label for={id}>{label}</label>
      <input
        id={id} type="number" value={value} min={min} max={max} step={step} disabled={disabled}
        onChange={(event) => {
          const field = event.currentTarget;
          const next = field.value === '' ? Number.NaN : Number(field.value);
          const kept = Number.isFinite(next) ? commit(next) : undefined;
          field.value = String(kept ?? value);
        }}
      />
    </p>
  );
}

/** The selected canvas box's fields, or nothing when no canvas box is selected. */
export function BoxProperties(): JSX.Element | null {
  const canvas = activeCanvas.value;
  const box = canvas?.box;
  if (canvas === undefined || box === undefined) return null;
  const { readOnly } = canvas;

  return (
    <fieldset class="box-properties">
      <legend>{t('canvas.box')}</legend>
      {FRAME_FIELDS.map(({ field, key, label }) => (
        <NumberField
          key={field} id={`box-${field}`} label={t(key)} value={percent(box.frame[field])} min={0} max={100} step={0.1} disabled={readOnly}
          commit={(next) => {
            const kept = canvas.change(label, { frame: { ...box.frame, [field]: next / 100 } });
            return kept === undefined ? undefined : percent(kept.frame[field]);
          }}
        />
      ))}
      <NumberField
        id="box-layer" label={t('canvas.layer')} value={box.layer} min={0} step={1} disabled={readOnly}
        commit={(next) => (Number.isInteger(next) && next >= 0 ? canvas.change('canvas.op.layer', { layer: next })?.layer : undefined)}
      />
      {box.kind === 'text' ? (
        <>
          <NumberField
            id="box-size" label={t('canvas.size')} value={percent(box.style.sizeRatio)} min={0.1} max={100} step={0.1} disabled={readOnly}
            commit={(next) => {
              if (next <= 0 || next > 100) return undefined;
              const kept = canvas.change('canvas.op.style', { style: { ...box.style, sizeRatio: next / 100 } });
              return kept?.kind === 'text' ? percent(kept.style.sizeRatio) : undefined;
            }}
          />
          <p>
            <label for="box-weight">{t('canvas.weight')}</label>
            <select
              id="box-weight" value={String(box.style.fontWeight)} disabled={readOnly}
              onChange={(event) => canvas.change('canvas.op.style', { style: { ...box.style, fontWeight: Number(event.currentTarget.value) } })}
            >
              {WEIGHTS.map((weight) => <option key={weight} value={String(weight)}>{weight}</option>)}
            </select>
          </p>
          <p>
            <label for="box-align">{t('canvas.align')}</label>
            <select
              id="box-align" value={box.style.align} disabled={readOnly}
              onChange={(event) => canvas.change('canvas.op.style', { style: { ...box.style, align: event.currentTarget.value as TextAlignment } })}
            >
              {TEXT_ALIGNMENTS.map((align) => <option key={align} value={align}>{t(ALIGN_KEYS[align])}</option>)}
            </select>
          </p>
        </>
      ) : (
        <p>
          <label for="box-fit">{t('canvas.fit.label')}</label>
          <select
            id="box-fit" value={box.fit} disabled={readOnly}
            onChange={(event) => canvas.change('canvas.op.fit', { fit: event.currentTarget.value as CustomMediaFit })}
          >
            {CUSTOM_MEDIA_FITS.map((fit) => <option key={fit} value={fit}>{t(FIT_KEYS[fit])}</option>)}
          </select>
        </p>
      )}
    </fieldset>
  );
}
