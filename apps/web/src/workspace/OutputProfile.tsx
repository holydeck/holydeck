// WS-11's client half: shows the output profile a service actually renders with — the administrative
// defaults, or this service's own override once it has one — and lets an operator with permission change
// either. Never optimistic: the ratio/source line above the form only ever reflects `service.value`, the
// server's own last word, while the controls below it hold a local draft that autosaves once the operator
// actually changes something.

import { useEffect, useRef, useState } from 'preact/hooks';

import { ENTITY_CONFLICT } from '@holydeck/contracts/http';
import { aspectRatioOf, MAX_SAFE_AREA_PERCENT, SAFE_AREA_EDGES, type SafeAreaEdge, type SafeAreaMargins } from '@holydeck/contracts/snapshots';
import type { JSX } from 'preact';

import { API } from '../api-routes.js';
import { useAutosave } from '../editors/use-autosave.js';
import { t } from '../i18n.js';
import { isReadOnly, mutate, service } from '../state/workspace-store.js';
import { loadOutputDefaults, outputDefaults, resolvedOutput } from './output-defaults.js';

const STANDARD_RATIOS = ['16:9', '4:3', '16:10'] as const;
type StandardRatio = (typeof STANDARD_RATIOS)[number];
const isStandard = (ratio: string): ratio is StandardRatio => (STANDARD_RATIOS as readonly string[]).includes(ratio);

type Draft = {
  readonly ratioChoice: StandardRatio | 'custom';
  readonly customRatio: string;
  readonly margins: SafeAreaMargins;
};

const draftFrom = (aspectRatio: string, safeAreaMargins: SafeAreaMargins): Draft =>
  isStandard(aspectRatio)
    ? { ratioChoice: aspectRatio, customRatio: '', margins: safeAreaMargins }
    : { ratioChoice: 'custom', customRatio: aspectRatio, margins: safeAreaMargins };

const ratioOf = (draft: Draft): string => (draft.ratioChoice === 'custom' ? draft.customRatio : draft.ratioChoice);

/** The administrative output profile, and this service's own override of it when it has set one. */
export function OutputProfile(): JSX.Element | null {
  const view = service.value;
  const defaults = outputDefaults.value;
  const readOnly = isReadOnly.value || view?.state === 'presenting';

  useEffect(() => {
    void loadOutputDefaults();
  }, []);

  const [draft, setDraft] = useState<Draft | undefined>(undefined);
  const [dirty, setDirty] = useState(false);
  const [locked, setLocked] = useState(false);
  const seededRevision = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (view === undefined || defaults === undefined) return;
    if (seededRevision.current === view.revision) return;
    seededRevision.current = view.revision;
    const resolved = resolvedOutput(view, defaults);
    setDraft(draftFrom(resolved.aspectRatio, resolved.safeAreaMargins));
    setDirty(false);
  }, [view?.revision, defaults]);

  const save = async (next: Draft): Promise<boolean> => {
    const current = service.value;
    if (current === undefined) return false;
    const ratio = ratioOf(next);
    if (aspectRatioOf(ratio) === undefined) return false;
    const result = await mutate(API.serviceOutput(current.id), {
      method: 'PATCH',
      body: { aspectRatio: ratio, safeAreaMargins: next.margins },
    });
    if (result.ok) {
      setLocked(false);
      return true;
    }
    if (result.code === ENTITY_CONFLICT) setLocked(true);
    return false;
  };

  useAutosave(draft ?? draftFrom('16:9', { top: 0, right: 0, bottom: 0, left: 0, unit: 'percent' }), save, {
    enabled: dirty && draft !== undefined && !readOnly,
  });

  if (view === undefined) return null;
  const resolved = defaults === undefined ? undefined : resolvedOutput(view, defaults);

  const change = (next: Draft): void => {
    setDraft(next);
    setDirty(true);
  };

  const changeMargin = (edge: SafeAreaEdge, raw: string): void => {
    if (draft === undefined) return;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.max(0, Math.min(MAX_SAFE_AREA_PERCENT, parsed));
    change({ ...draft, margins: { ...draft.margins, [edge]: clamped } });
  };

  const useDefault = async (): Promise<void> => {
    const current = service.value;
    if (current === undefined) return;
    const result = await mutate(API.serviceOutput(current.id), { method: 'PATCH', body: {} });
    setLocked(!result.ok && result.code === ENTITY_CONFLICT);
  };

  const customInvalid = draft?.ratioChoice === 'custom' && aspectRatioOf(draft.customRatio) === undefined;

  return (
    <div>
      <fieldset disabled={readOnly || draft === undefined}>
        <legend>{t('output.heading')}</legend>
        {resolved === undefined ? null : (
          <p>
            {`${t('output.ratio', { ratio: resolved.aspectRatio })} ${t(resolved.source === 'default' ? 'output.source.default' : 'output.source.service')}`}
          </p>
        )}
        {STANDARD_RATIOS.map((ratio) => (
          <label key={ratio}>
            <input
              type="radio"
              name="output-ratio"
              checked={draft?.ratioChoice === ratio}
              onChange={() => draft !== undefined && change({ ...draft, ratioChoice: ratio })}
            />
            {' '}{ratio}
          </label>
        ))}
        <label>
          <input
            type="radio"
            name="output-ratio"
            checked={draft?.ratioChoice === 'custom'}
            onChange={() => draft !== undefined && change({ ...draft, ratioChoice: 'custom' })}
          />
          {' '}{t('output.ratio.custom')}
        </label>
        <label>
          {t('output.ratio.customField')}
          <input
            type="text"
            aria-label={t('output.ratio.customField')}
            value={draft?.customRatio ?? ''}
            onInput={(event) => draft !== undefined && change({ ...draft, ratioChoice: 'custom', customRatio: event.currentTarget.value })}
          />
        </label>
        {customInvalid ? <p>{t('output.ratio.invalid')}</p> : null}

        <p>{t('output.margins')}</p>
        {SAFE_AREA_EDGES.map((edge) => (
          <label key={edge}>
            {t(`output.margin.${edge}`)}
            <input
              type="number"
              min={0}
              max={MAX_SAFE_AREA_PERCENT}
              value={draft?.margins[edge] ?? 0}
              onInput={(event) => changeMargin(edge, event.currentTarget.value)}
            />
            {'%'}
          </label>
        ))}

        <button type="button" onClick={() => void useDefault()}>{t('output.useDefault')}</button>
      </fieldset>
      {locked ? <p>{t('output.locked')}</p> : null}
    </div>
  );
}
