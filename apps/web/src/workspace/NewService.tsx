// The one way to create a Service: blank, from an Admin Template, or a copy of one already scheduled
// (WS-03). Once created, the workspace only ever edits sections (P-9) — title and site can never be
// changed again, so this page is the only place either is ever set. A duplicated service keeps its
// source's title and site verbatim (the server has no route to change them), so only its date is offered
// as an editable field for that source. A template's entries are shown when this account may read them;
// only a custom-slide slot can be filled here, since every other slot needs pinned content chosen in the
// workspace.

import { useEffect, useState } from 'preact/hooks';

import type { ItemKind } from '@holydeck/contracts/services';
import type { JSX } from 'preact';

import { API } from '../api-routes.js';
import { csrf } from '../app-state.js';
import { FormField } from '../components/form-field.js';
import { useDraft } from '../drafts.js';
import { fieldErrors } from '../form-errors.js';
import { t } from '../i18n.js';
import { request } from '../request.js';
import { navigate } from '../router.js';
import { KIND_KEY } from './OrderItem.js';
import { readServiceList, readServiceView, type ServiceView } from './service-data.js';

type Source = 'blank' | 'template' | 'previous';
const FIELDS = ['date', 'title', 'site'] as const;
const DRAFT_KEY = 'new-service';
const FILL = 'fill:';

/** One template as the list names it. */
type TemplateChoice = { readonly id: string; readonly name: string };

/** One template entry as this page shows it. */
type TemplateEntry = {
  readonly id: string; readonly section: string; readonly kind: ItemKind;
  readonly slot: 'fixed' | 'typed'; readonly title: string; readonly required: boolean;
};

const emptyDraft = (): Record<string, string> => ({ source: 'blank', previousId: '', templateId: '', title: '', date: '', site: '' });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const listOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

/** The templates in a list answer that carry an id and a name. */
export function readTemplateChoices(data: unknown): TemplateChoice[] {
  return listOf(data).flatMap((entry) =>
    isRecord(entry) && typeof entry['id'] === 'string' && typeof entry['name'] === 'string' ? [{ id: entry['id'], name: entry['name'] }] : []);
}

/** Every entry of one template preview, in section order; `undefined` for an answer that is not one. */
export function readTemplateEntries(data: unknown): TemplateEntry[] | undefined {
  if (!isRecord(data) || !isRecord(data['body']) || !Array.isArray(data['body']['sections'])) return undefined;
  return data['body']['sections'].flatMap((section) => {
    if (!isRecord(section)) return [];
    const name = typeof section['name'] === 'string' ? section['name'] : '';
    return listOf(section['entries']).flatMap((entry): TemplateEntry[] => {
      if (!isRecord(entry) || typeof entry['id'] !== 'string' || typeof entry['itemKind'] !== 'string' || !(entry['itemKind'] in KIND_KEY)) return [];
      const slot = entry['slot'] === 'fixed' ? 'fixed' : 'typed';
      return [{
        id: entry['id'], section: name, kind: entry['itemKind'] as ItemKind, slot,
        title: typeof entry['title'] === 'string' ? entry['title'] : '', required: entry['required'] === true,
      }];
    });
  });
}

const isSource = (value: string | undefined): value is Source =>
  value === 'blank' || value === 'template' || value === 'previous';

const enc = encodeURIComponent;

/** Blank, or a copy of an existing Service — the only place a title or site is ever set (P-9). */
export function NewService(): JSX.Element {
  const [draft, setDraft, clear] = useDraft(DRAFT_KEY, emptyDraft());
  const [previous, setPrevious] = useState<readonly ServiceView[] | undefined>(undefined);
  const [templates, setTemplates] = useState<readonly TemplateChoice[] | undefined>(undefined);
  const [entries, setEntries] = useState<readonly TemplateEntry[] | 'hidden' | undefined>(undefined);
  const [errors, setErrors] = useState<Readonly<Record<string, string | undefined>>>({});
  const [other, setOther] = useState<string>();
  const [partialCopyId, setPartialCopyId] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void (async (): Promise<void> => {
      const result = await request(API.services);
      const list = result.ok ? readServiceList(result.data) ?? [] : [];
      setPrevious(list.filter((view) => view.state !== 'archived'));
    })();
    void (async (): Promise<void> => {
      const result = await request(API.serviceTemplates);
      setTemplates(result.ok ? readTemplateChoices(result.data) : []);
    })();
  }, []);

  const source: Source = isSource(draft.source) ? draft.source : 'blank';
  const templateId = source === 'template' ? draft.templateId ?? '' : '';

  useEffect(() => {
    setEntries(undefined);
    if (templateId === '') return undefined;
    let current = true;
    void (async (): Promise<void> => {
      const result = await request(API.serviceTemplate(templateId));
      const read = result.ok ? readTemplateEntries(result.data) : undefined;
      if (current) setEntries(read ?? 'hidden');
    })();
    return () => { current = false; };
  }, [templateId]);

  const previousId = draft.previousId ?? '';
  const selected = previous?.find((view) => view.id === previousId);
  const previousEmpty = previous !== undefined && previous.length === 0;
  const templatesEmpty = templates !== undefined && templates.length === 0;
  const entryIds = Array.isArray(entries) ? entries.map((entry) => entry.id) : [];
  const dirty = JSON.stringify(draft) !== JSON.stringify(emptyDraft());

  const change = (field: string) => (value: string): void => {
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
      ...(next === 'template' ? { templateId: draft.templateId === '' || draft.templateId === undefined ? templates?.[0]?.id ?? '' : draft.templateId } : {}),
    });
    setErrors({});
    setOther(undefined);
  };

  const choosePrevious = (id: string): void => {
    const found = previous?.find((view) => view.id === id);
    setDraft({ ...draft, previousId: id, date: found?.date ?? (draft.date ?? '') });
  };

  const focusFirst = (invalid: Readonly<Record<string, string | undefined>>): void => {
    const field = [...FIELDS, ...entryIds].find((name) => invalid[name] !== undefined);
    if (field === undefined) return;
    const id = (FIELDS as readonly string[]).includes(field) ? `service-new-${field}` : `service-new-fill-${field}`;
    document.getElementById(id)?.focus();
  };

  const validate = (): Record<string, string> => {
    const invalid: Record<string, string> = {};
    if ((draft.date ?? '') === '') invalid['date'] = t('form.error.required');
    if (source !== 'previous') {
      if ((draft.title ?? '') === '') invalid['title'] = t('form.error.required');
      if ((draft.site ?? '') === '') invalid['site'] = t('form.error.required');
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

  const createFromTemplate = async (): Promise<string | undefined> => {
    if (templateId === '') return undefined;
    const fills = Array.isArray(entries)
      ? entries.flatMap((entry) => {
        const title = (draft[`${FILL}${entry.id}`] ?? '').trim();
        return entry.slot === 'typed' && entry.kind === 'custom-slide' && title !== '' ? [{ entryId: entry.id, title }] : [];
      })
      : [];
    const result = await request(API.templateInstantiate(templateId), {
      method: 'POST',
      csrf: csrf() ?? '',
      body: { title: draft.title ?? '', date: draft.date ?? '', site: draft.site ?? '', fills },
    });
    if (!result.ok) {
      const mapped = fieldErrors(result, [...FIELDS, ...entryIds]);
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
      const id = source === 'previous' ? await createFromPrevious() : source === 'template' ? await createFromTemplate() : await createBlank();
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
            <input
              type="radio"
              name="source"
              disabled={templates === undefined || templatesEmpty}
              checked={source === 'template'}
              onChange={() => chooseSource('template')}
            />
            {' '}{t('serviceNew.source.template')}
          </label>
          {templatesEmpty ? <p>{t('serviceNew.template.none')}</p> : null}
          {source === 'template' && templates !== undefined && templates.length > 0 ? (
            <label>
              {t('serviceNew.template.pick')}
              <select value={templateId} onChange={(event) => setDraft({ ...draft, templateId: event.currentTarget.value })}>
                {templates.map((choice) => <option value={choice.id} key={choice.id}>{choice.name}</option>)}
              </select>
            </label>
          ) : null}
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

        {source === 'template' && entries === 'hidden' ? <p>{t('serviceNew.template.hidden')}</p> : null}
        {source === 'template' && Array.isArray(entries) && entries.length > 0 ? (
          <fieldset>
            <legend>{t('serviceNew.template.entries')}</legend>
            {entries.map((entry) => <TemplateEntryField key={entry.id} entry={entry} value={draft[`${FILL}${entry.id}`] ?? ''} error={errors[entry.id]} onInput={change(`${FILL}${entry.id}`)} />)}
          </fieldset>
        ) : null}

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

/** One template entry: a fixed one is only named, a custom-slide slot takes its title, and any other slot
 *  says where its content is chosen. A refusal the server names for that entry is shown beside it. */
function TemplateEntryField({ entry, value, error, onInput }: {
  readonly entry: TemplateEntry; readonly value: string; readonly error: string | undefined; readonly onInput: (value: string) => void;
}): JSX.Element {
  const kind = t(KIND_KEY[entry.kind]);
  if (entry.slot === 'typed' && entry.kind === 'custom-slide') {
    return (
      <FormField
        id={`service-new-fill-${entry.id}`}
        label={t(entry.required ? 'serviceNew.template.slot.required' : 'serviceNew.template.slot', { kind, section: entry.section })}
        value={value}
        onInput={onInput}
        error={error}
        required={entry.required}
      />
    );
  }
  const text = entry.slot === 'fixed'
    ? t('serviceNew.template.fixed', { kind, title: entry.title, section: entry.section })
    : t('serviceNew.template.slot.content', { kind, section: entry.section });
  return (
    <div>
      <p id={`service-new-fill-${entry.id}`} tabIndex={-1} aria-describedby={error === undefined ? undefined : `service-new-fill-${entry.id}-error`}>{text}</p>
      {error === undefined ? null : <p id={`service-new-fill-${entry.id}-error`} class="form-error">{error}</p>}
    </div>
  );
}
