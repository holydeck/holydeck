// The Properties panel's half of the slide group editor (SLID-02): the slide being edited in the center
// may override its group's Slide Layout and background, and each field says plainly whether it is
// "Inherited from group" or "Overridden". The editor owns the group and publishes the slide under edit
// through `activeSlide`; every change here goes back through the editor's own `send`, so the one group
// the center shows is also the one this panel reads.

import { signal, type Signal } from '@preact/signals';
import { resolveSlide, type Slide, type SlideGroupBody } from '@holydeck/contracts/slide-groups';
import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import type { Change } from '../api.js';
import { API } from '../api-routes.js';
import { t } from '../i18n.js';
import { request } from '../request.js';
import { useSlideLayouts } from '../workspace/tabs/song-sources.js';
import { readMediaChoices, type MediaChoice } from './CustomSlideCanvas.js';

/** The slide the group editor has open, and how to change its group. */
export interface ActiveSlide {
  readonly groupId: string;
  readonly group: SlideGroupBody;
  readonly slide: Slide;
  readonly canEdit: boolean;
  /** Sends one change to the group and takes the group the server answers with. */
  readonly send: (path: string, change: Omit<Change, 'csrf'>) => Promise<void>;
}

/** The slide open in the slide group editor, or undefined while none is. */
export const activeSlide: Signal<ActiveSlide | undefined> = signal(undefined);

function useMediaChoices(): readonly MediaChoice[] {
  const [choices, setChoices] = useState<readonly MediaChoice[]>([]);
  useEffect(() => {
    let current = true;
    void request(API.mediaUpload).then((answer) => {
      if (current && answer.ok) setChoices(readMediaChoices(answer.data) ?? []);
    });
    return () => { current = false; };
  }, []);
  return choices;
}

interface OverrideFieldProps {
  readonly legend: string;
  readonly source: 'inherited' | 'override';
  readonly value: string;
  readonly options: readonly { readonly id: string; readonly name: string }[];
  readonly disabled: boolean;
  readonly onSet: (id: string) => void;
  readonly onClear: () => void;
}

function OverrideField({ legend, source, value, options, disabled, onSet, onClear }: OverrideFieldProps): JSX.Element {
  const overridden = source === 'override';
  const shown = overridden && !options.some((option) => option.id === value) ? [...options, { id: value, name: value }] : options;
  return (
    <fieldset>
      <legend>{legend}</legend>
      <p>{t(overridden ? 'slides.overridden' : 'slides.inherited')}</p>
      <select
        aria-label={legend}
        value={overridden ? value : ''}
        disabled={disabled}
        onChange={(event) => {
          const next = event.currentTarget.value;
          if (next === '') onClear();
          else onSet(next);
        }}
      >
        <option value="">{t('slides.groupDefault')}</option>
        {shown.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
      </select>
      {overridden ? <button type="button" disabled={disabled} onClick={onClear}>{t('slides.clearOverride')}</button> : null}
    </fieldset>
  );
}

/** The open slide's Slide Layout and background overrides, or nothing while no slide is open. */
export function SlideOverrides(): JSX.Element | null {
  const active = activeSlide.value;
  return active === undefined ? null : <OverridesOf active={active} />;
}

function OverridesOf({ active }: { readonly active: ActiveSlide }): JSX.Element {
  const layouts = useSlideLayouts();
  const media = useMediaChoices();
  const { groupId, group, slide, canEdit, send } = active;
  const resolved = resolveSlide(group, slide);
  const layoutOptions = layouts.status === 'ready' ? layouts.value : [];
  return (
    <section aria-label={t('slides.overrides')}>
      <OverrideField
        legend={t('slides.layout')}
        source={resolved.slideLayoutId.source}
        value={resolved.slideLayoutId.value}
        options={layoutOptions}
        disabled={!canEdit}
        onSet={(slideLayoutId) => void send(API.slideLayoutOverride(groupId, slide.id), { method: 'PUT', body: { slideLayoutId } })}
        onClear={() => void send(API.slideLayoutOverride(groupId, slide.id), { method: 'DELETE' })}
      />
      <OverrideField
        legend={t('slides.background')}
        source={resolved.background.source}
        value={resolved.background.value ?? ''}
        options={media.map((choice) => ({ id: choice.id, name: choice.id }))}
        disabled={!canEdit}
        onSet={(background) => void send(API.slideBackgroundOverride(groupId, slide.id), { method: 'PUT', body: { background } })}
        onClear={() => void send(API.slideBackgroundOverride(groupId, slide.id), { method: 'DELETE' })}
      />
    </section>
  );
}
