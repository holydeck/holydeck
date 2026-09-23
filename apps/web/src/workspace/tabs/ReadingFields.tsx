// The five fields that pick a passage — translation, book, chapter, verses and up to three translations to
// compare with. The Bible tab uses them to build a new reading and the Reading editor to change an existing
// one, so the two can never offer different choices. The fields only report changes; whoever holds the
// reading decides what a change means (a draft before Insert, an autosaved edit after it).

import type { CorpusCanonBook, CorpusTranslation } from '@holydeck/contracts/corpus';
import type { JSX } from 'preact';

import { t } from '../../i18n.js';
import { MAX_COMPARE, type ReadingDraft } from './bible-sources.js';

export type ReadingField = keyof ReadingDraft;

export interface ReadingFieldsProps {
  readonly idPrefix: string;
  readonly value: ReadingDraft;
  readonly translations: readonly CorpusTranslation[];
  readonly books: readonly CorpusCanonBook[];
  readonly disabled?: boolean;
  readonly onChange: <F extends ReadingField>(field: F, next: ReadingDraft[F]) => void;
}

/** The passage pickers, labelled so each one can be found by its name. */
export function ReadingFields({ idPrefix, value, translations, books, disabled = false, onChange }: ReadingFieldsProps): JSX.Element {
  const id = (name: string): string => `${idPrefix}-${name}`;
  const atMax = value.compare.length >= MAX_COMPARE;
  const others = translations.filter((translation) => translation.abbreviation !== value.translation);

  const toggleCompare = (abbr: string, checked: boolean): void => {
    onChange('compare', checked ? [...value.compare, abbr] : value.compare.filter((entry) => entry !== abbr));
  };

  return (
    <div class="reading-fields">
      <label for={id('translation')}>{t('bible.translation')}</label>
      <select
        id={id('translation')} value={value.translation} disabled={disabled}
        onChange={(event) => onChange('translation', event.currentTarget.value)}
      >
        {translations.map((translation) => (
          <option key={translation.abbreviation} value={translation.abbreviation}>{translation.title}</option>
        ))}
      </select>

      <label for={id('book')}>{t('bible.book')}</label>
      <select id={id('book')} value={value.book} disabled={disabled} onChange={(event) => onChange('book', event.currentTarget.value)}>
        <option value="" />
        {books.map((book) => <option key={book.usfm} value={book.usfm}>{book.name}</option>)}
      </select>

      <label for={id('chapter')}>{t('bible.chapter')}</label>
      <input
        id={id('chapter')} type="number" min={1} inputMode="numeric" disabled={disabled}
        value={Number.isNaN(value.chapter) ? '' : value.chapter}
        onInput={(event) => onChange('chapter', event.currentTarget.value === '' ? Number.NaN : Number(event.currentTarget.value))}
      />

      <label for={id('verses')}>{t('bible.verses')}</label>
      <input
        id={id('verses')} type="text" placeholder="16-18" disabled={disabled} value={value.verses}
        onInput={(event) => onChange('verses', event.currentTarget.value.replace(/\s/gu, ''))}
      />

      {others.length === 0 ? null : (
        <fieldset class="reading-compare">
          <legend>{t('bible.compare')}</legend>
          {others.map((translation) => {
            const checked = value.compare.includes(translation.abbreviation);
            return (
              <label key={translation.abbreviation}>
                <input
                  type="checkbox" checked={checked} disabled={disabled || (atMax && !checked)}
                  onChange={(event) => toggleCompare(translation.abbreviation, event.currentTarget.checked)}
                />
                {translation.title}
              </label>
            );
          })}
          {atMax ? <p role="note">{t('bible.compare.max')}</p> : null}
        </fieldset>
      )}
    </div>
  );
}
