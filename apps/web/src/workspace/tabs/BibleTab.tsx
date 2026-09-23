// The Add panel's Bible source (WS-08): pick a translation, book, chapter and verses, optionally up to three
// more translations to show alongside, read the passage stacked per translation with its verse offset, and
// only then Insert it where `InsertLocation` says. The search box narrows the book list. An offset is a
// setting of the whole installation, so its editor is shown only to someone who holds `settings.manage` (P-7).

import type { CorpusCanonBook } from '@holydeck/contracts/corpus';
import type { ServiceItem } from '@holydeck/contracts/services';
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';

import { can } from '../../app-state.js';
import { t } from '../../i18n.js';
import { isReadOnly } from '../../state/workspace-store.js';
import { insertAndSelect, InsertLocation, useInsertTarget } from '../InsertLocation.js';
import { readingIsValid, saveOffset, useBooks, useOffsets, usePassage, useTranslations, type Loaded, type ReadingDraft } from './bible-sources.js';
import { ReadingFields } from './ReadingFields.js';

/** A source that could not be read: what happened, a way to try again, and the code for support. */
export function SourceError({ code, retry }: { readonly code: string; readonly retry: () => void }): JSX.Element {
  return (
    <div role="alert" class="add-error">
      <p>{t('add.error')}</p>
      <button type="button" onClick={retry}>{t('workspace.load.retry')}</button>
      <details>
        <summary>{t('preview.error.details')}</summary>
        <code>{code}</code>
      </details>
    </div>
  );
}

/** The heading and advice shown when the search leaves nothing to pick. */
export function NoMatch(): JSX.Element {
  return (
    <div class="add-no-match">
      <h3>{t('add.noMatch.heading')}</h3>
      <p>{t('add.noMatch.body')}</p>
    </div>
  );
}

/** A reading's title in the order: the book's name, then chapter and verses. */
export function readingTitle(draft: ReadingDraft, books: readonly CorpusCanonBook[]): string {
  const name = books.find((book) => book.usfm === draft.book)?.name ?? draft.book;
  return `${name} ${draft.chapter}:${draft.verses}`;
}

function Passage({ abbr, title, draft, offset }: { readonly abbr: string; readonly title: string; readonly draft: ReadingDraft; readonly offset: number }): JSX.Element {
  const passage = usePassage(abbr, draft);
  return (
    <section class="bible-passage" aria-label={title}>
      <h3>{title}</h3>
      <p>{t('bible.offset', { n: offset })}</p>
      {passage === undefined ? null
        : passage.status === 'loading' ? <p role="status">{t('app.loading')}</p>
        : passage.status === 'error' ? <p role="alert">{t('add.error')} <code>{passage.code}</code></p>
        : Object.entries(passage.value.verses).map(([verse, text]) => (
          <p key={verse}><sup>{verse}</sup> {text}</p>
        ))}
    </section>
  );
}

function OffsetEditor({ abbr, offset, onSaved }: { readonly abbr: string; readonly offset: number; readonly onSaved: (offset: number) => void }): JSX.Element {
  const [value, setValue] = useState(String(offset));
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const save = async (): Promise<void> => {
    const next = Number(value);
    if (value === '' || !Number.isInteger(next)) return;
    const code = await saveOffset(abbr, next);
    setRefusal(code);
    if (code === undefined) onSaved(next);
  };
  return (
    <div class="bible-offset-editor">
      <label for="bible-offset">{t('bible.offset.edit')}</label>
      <input id="bible-offset" type="number" step={1} value={value} onInput={(event) => setValue(event.currentTarget.value)} />
      <button type="button" onClick={() => void save()}>{t('bible.offset.save')}</button>
      {refusal === undefined ? null : <p role="alert">{t('add.error')} <code>{refusal}</code></p>}
    </div>
  );
}

const EMPTY: ReadingDraft = { translation: '', compare: [], book: '', chapter: Number.NaN, verses: '' };

const readyOr = <T,>(state: Loaded<readonly T[]>): readonly T[] => (state.status === 'ready' ? state.value : []);

/** The Bible tab's list, passage preview, location and Insert. */
export function BibleTab({ query }: { readonly query: string }): JSX.Element {
  const [translations, retryTranslations] = useTranslations();
  const [draft, setDraft] = useState<ReadingDraft>(EMPTY);
  const translationList = readyOr(translations);
  const reading: ReadingDraft = { ...draft, translation: draft.translation || (translationList[0]?.abbreviation ?? '') };
  const [books, retryBooks] = useBooks(reading.translation);
  const [offsets, offsetSaved] = useOffsets();
  const [target, setTarget] = useInsertTarget();
  const [busy, setBusy] = useState(false);

  if (translations.status === 'loading') return <p role="status">{t('app.loading')}</p>;
  if (translations.status === 'error') return <SourceError code={translations.code} retry={retryTranslations} />;

  const bookList = readyOr(books);
  const needle = query.trim().toLowerCase();
  const matching = needle === '' ? bookList
    : bookList.filter((book) => book.usfm === reading.book || book.name.toLowerCase().includes(needle) || book.usfm.toLowerCase().includes(needle));
  const titleOf = (abbr: string): string => translationList.find((entry) => entry.abbreviation === abbr)?.title ?? abbr;
  const valid = readingIsValid(reading);

  const insert = async (): Promise<void> => {
    if (target === undefined) return;
    setBusy(true);
    const item: ServiceItem = {
      id: globalThis.crypto.randomUUID(), kind: 'reading', title: readingTitle(reading, bookList), enabled: true,
      content: undefined, body: { kind: 'reading', ...reading },
    };
    if (await insertAndSelect(target, item)) setTarget(undefined);
    setBusy(false);
  };

  return (
    <div class="bible-tab">
      {books.status === 'error' ? <SourceError code={books.code} retry={retryBooks} /> : null}
      <ReadingFields
        idPrefix="bible" value={reading} translations={translationList} books={matching}
        onChange={(field, next) => setDraft({ ...reading, [field]: next })}
      />
      {needle !== '' && books.status === 'ready' && matching.length === 0 ? <NoMatch /> : null}
      {reading.book === '' ? <p>{t('add.initial')}</p> : (
        [reading.translation, ...reading.compare].map((abbr) => (
          <Passage key={abbr} abbr={abbr} title={titleOf(abbr)} draft={reading} offset={offsets.get(abbr) ?? 0} />
        ))
      )}
      {can('settings.manage') && reading.translation !== '' ? (
        <OffsetEditor
          key={`${reading.translation}:${offsets.get(reading.translation) ?? 0}`} abbr={reading.translation}
          offset={offsets.get(reading.translation) ?? 0}
          onSaved={(offset) => offsetSaved({ abbr: reading.translation, offset })}
        />
      ) : null}
      <InsertLocation idPrefix="bible-insert" value={target} onChange={setTarget} />
      <button type="button" disabled={!valid || target === undefined || isReadOnly.value || busy} onClick={() => void insert()}>
        {t('add.insert')}
      </button>
    </div>
  );
}
