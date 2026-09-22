// The one way to create a Service: blank, or a copy of one already scheduled (WS-03; the Admin Template
// source arrives once Task 21 wires spec 02's templates in). Once created, the workspace only ever edits
// sections (P-9) — title and site can never be changed again, so this page is the only place either is
// ever set. A duplicated service keeps its source's title and site verbatim (the server has no route to
// change them), so only its date is offered as an editable field for that source.

import { useEffect, useState } from 'preact/hooks';

import type { JSX } from 'preact';

import { API } from '../api-routes.js';
import { csrf } from '../app-state.js';
import { FormField } from '../components/form-field.js';
import { useDraft } from '../drafts.js';
import { fieldErrors } from '../form-errors.js';
import { t } from '../i18n.js';
import { request } from '../request.js';
import { navigate } from '../router.js';
import { readServiceList, readServiceView, type ServiceView } from './service-data.js';

type Source = 'blank' | 'template' | 'previous';
const FIELDS = ['date', 'title', 'site'] as const;
type Field = (typeof FIELDS)[number];
const DRAFT_KEY = 'new-service';

const emptyDraft = (): Record<string, string> => ({ source: 'blank', previousId: '', title: '', date: '', site: '' });

const isSource = (value: string | undefined): value is Source =>
  value === 'blank' || value === 'template' || value === 'previous';

const enc = encodeURIComponent;

/** Blank, or a copy of an existing Service — the only place a title or site is ever set (P-9). */
export function NewService(): JSX.Element {
  const [draft, setDraft, clear] = useDraft(DRAFT_KEY, emptyDraft());
  const [previous, setPrevious] = useState<readonly ServiceView[] | undefined>(undefined);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [other, setOther] = useState<string>();
  const [partialCopyId, setPartialCopyId] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void (async (): Promise<void> => {
      const result = await request(API.services);
      const list = result.ok ? readServiceList(result.data) ?? [] : [];
      setPrevious(list.filter((view) => view.state !== 'archived'));
    })();
  }, []);

  const source: Source = isSource(draft.source) ? draft.source : 'blank';
  const previousId = draft.previousId ?? '';
  const selected = previous?.find((view) => view.id === previousId);
  const previousEmpty = previous !== undefined && previous.length === 0;
  const dirty = JSON.stringify(draft) !== JSON.stringify(emptyDraft());

  const change = (field: 'title' | 'date' | 'site') => (value: string): void => {
    setDraft({ ...draft, [field]: value });
    setErrors((current) => ({ ...current, [field]: undefined }));
    setOther(undefined);
  };

  const chooseSource = (next: Source): void => {
    const first = next === 'previous' ? previous?.[0] : undefined;
    setDraft({
      ...draft,
      source: next,
      ...(next === 'previous' ? { previousId: first?.id ?? '', date: first?.date ?? (draft.date ?? '') } : {}),
    });
    setErrors({});
    setOther(undefined);
  };

  const choosePrevious = (id: string): void => {
    const found = previous?.find((view) => view.id === id);
    setDraft({ ...draft, previousId: id, date: found?.date ?? (draft.date ?? '') });
  };

  const focusFirst = (invalid: Partial<Record<Field, string>>): void => {
    const field = FIELDS.find((name) => invalid[name] !== undefined);
    if (field !== undefined) document.getElementById(`service-new-${field}`)?.focus();
  };

  const validate = (): Partial<Record<Field, string>> => {
    const invalid: Partial<Record<Field, string>> = {};
    if ((draft.date ?? '') === '') invalid.date = t('form.error.required');
    if (source === 'blank') {
      if ((draft.title ?? '') === '') invalid.title = t('form.error.required');
      if ((draft.site ?? '') === '') invalid.site = t('form.error.required');
    }
    return invalid;
  };

  const createBlank = async (): Promise<string | undefined> => {
    const result = await request(API.services, {
      method: 'POST',
      csrf: csrf() ?? '',
      body: { title: draft.title ?? '', date: draft.date ?? '', site: draft.site ?? '', sections: [] },
    });
    if (!result.ok) {
      const mapped = fieldErrors(result, FIELDS);
      setErrors(mapped.byField);
      setOther(mapped.other);
      focusFirst(mapped.byField);
      return undefined;
    }
    return readServiceView(result.data)?.id;
  };

  const createFromPrevious = async (): Promise<string | undefined> => {
    if (selected === undefined) return undefined;
    const duplicated = await request(API.serviceDuplicate(selected.id), { method: 'POST', csrf: csrf() ?? '' });
    if (!duplicated.ok) {
      setOther(fieldErrors(duplicated, []).other);
      return undefined;
    }
    const copy = readServiceView(duplicated.data);
    if (copy === undefined) return undefined;

    const scheduled = await request(API.serviceSchedule(copy.id), {
      method: 'POST',
      csrf: csrf() ?? '',
      body: { date: draft.date ?? '' },
    });
    if (!scheduled.ok) {
      setPartialCopyId(copy.id);
      setOther(fieldErrors(scheduled, ['date']).other);
      return undefined;
    }
    return copy.id;
  };

  const submit = async (event: JSX.TargetedEvent<HTMLFormElement, SubmitEvent>): Promise<void> => {
    event.preventDefault();
    const invalid = validate();
    if (Object.keys(invalid).length !== 0) {
      setErrors(invalid);
      setOther(t('form.error.summary'));
      focusFirst(invalid);
      return;
    }

    setSubmitting(true);
    setErrors({});
    setOther(undefined);
    setPartialCopyId(undefined);
    try {
      const id = source === 'previous' ? await createFromPrevious() : await createBlank();
      if (id === undefined) return;
      clear();
      navigate(`/services/${enc(id)}`);
    } finally {
      setSubmitting(false);
    }
  };

  const discard = (): void => {
    if (dirty && !globalThis.confirm(t('serviceNew.discard.confirm'))) return;
    clear();
    navigate('/services');
  };

  return (
    <>
      <h1>{t('serviceNew.title')}</h1>
      <p><a href="/services">{t('serviceNew.back')}</a></p>
      {other === undefined ? null : <p role="alert">{other}</p>}
      {partialCopyId === undefined ? null : (
        <p role="alert">
          {t('serviceNew.previous.partial')}{' '}
          <a href={`/services/${enc(partialCopyId)}`}>{t('serviceNew.previous.partial.link')}</a>
        </p>
      )}
      <form onSubmit={(event) => void submit(event)}>
        <fieldset>
          <legend>{t('serviceNew.source')}</legend>
          <label>
            <input type="radio" name="source" checked={source === 'blank'} onChange={() => chooseSource('blank')} />
            {' '}{t('serviceNew.source.blank')}
          </label>
          <label>
            <input type="radio" name="source" disabled checked={source === 'template'} onChange={() => chooseSource('template')} />
            {' '}{t('serviceNew.source.template')}
          </label>
          <p>{t('serviceNew.template.later')}</p>
          <label>
            <input
              type="radio"
              name="source"
              disabled={previousEmpty}
              checked={source === 'previous'}
              onChange={() => chooseSource('previous')}
            />
            {' '}{t('serviceNew.source.previous')}
          </label>
          {previousEmpty ? <p>{t('serviceNew.previous.none')}</p> : null}
          {source === 'previous' && previous !== undefined && previous.length > 0 ? (
            <label>
              {t('serviceNew.previous.pick')}
              <select value={previousId} onChange={(event) => choosePrevious(event.currentTarget.value)}>
                {previous.map((view) => <option value={view.id} key={view.id}>{`${view.title} — ${view.date}`}</option>)}
              </select>
            </label>
          ) : null}
        </fieldset>

        <FormField
          id="service-new-date"
          label={t('serviceNew.date')}
          type="date"
          value={draft.date ?? ''}
          onInput={change('date')}
          error={errors.date}
          required
        />
        {source === 'previous' ? (
          selected === undefined ? null : <p>{t('serviceNew.previous.copied', { title: selected.title, site: selected.site })}</p>
        ) : (
          <>
            <FormField
              id="service-new-title"
              label={t('serviceNew.titleField')}
              value={draft.title ?? ''}
              onInput={change('title')}
              error={errors.title}
              required
            />
            <FormField
              id="service-new-site"
              label={t('serviceNew.site')}
              value={draft.site ?? ''}
              onInput={change('site')}
              error={errors.site}
              required
            />
          </>
        )}

        <button type="submit" disabled={submitting}>{t('serviceNew.create')}</button>{' '}
        <button type="button" onClick={discard}>{t('serviceNew.discard')}</button>
      </form>
    </>
  );
}
