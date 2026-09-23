// The Bible reads the Add panel's Bible tab and the Reading editor share: which translations exist, the
// books of the chosen one, each translation's verse offset, and a passage's text. Both screens edit the same
// five reading fields, so they read them the same way — one loader per source, each answering either its
// parsed value or the refusal code to show, never a half-read shape.

import { parseCorpusCanon, parseCorpusTranslations, parseCorpusVerses, type CorpusCanonBook, type CorpusTranslation, type CorpusVerses } from '@holydeck/contracts/corpus';
import { isRecord, type Parsed } from '@holydeck/contracts/problems';
import type { ReadingBody } from '@holydeck/contracts/services';
import { parseTranslationOffsetList, type TranslationOffsetEntry } from '@holydeck/contracts/translation-offsets';
import { useEffect, useState } from 'preact/hooks';

import { UNREADABLE_RESPONSE } from '../../api.js';
import { API } from '../../api-routes.js';
import { csrf } from '../../app-state.js';
import { request } from '../../request.js';

/** A source's read: still on its way, arrived, or refused with the code to show. */
export type Loaded<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly value: T }
  | { readonly status: 'error'; readonly code: string };

/** The fields of a reading the person picks, without the layout a later task binds. */
export type ReadingDraft = Pick<ReadingBody, 'translation' | 'compare' | 'book' | 'chapter' | 'verses'>;

/** Every reading carries its own translation plus at most this many more to compare with. */
export const MAX_COMPARE = 3;

const VERSES = /^\d+(-\d+)?(,\d+(-\d+)?)*$/u;

/** Whether the server would take this reading as it stands — the same rules `parseServiceItemBody` applies,
 *  including that verses are required (its text reading refuses an empty value). */
export function readingIsValid(draft: ReadingDraft): boolean {
  return draft.translation !== '' && draft.book !== '' && Number.isInteger(draft.chapter) && draft.chapter >= 1 &&
    draft.compare.length <= MAX_COMPARE && VERSES.test(draft.verses);
}

async function read<T>(path: string, parse: (data: unknown) => Parsed<T>): Promise<Loaded<T>> {
  const answer = await request(path);
  if (!answer.ok) return { status: 'error', code: answer.code };
  const parsed = parse(answer.data);
  return parsed.ok ? { status: 'ready', value: parsed.value } : { status: 'error', code: UNREADABLE_RESPONSE };
}

const inside = <T>(key: string, parse: (value: unknown) => Parsed<T>) => (data: unknown): Parsed<T> =>
  parse(isRecord(data) ? data[key] : undefined);

/** Reads one source again whenever `path` changes, and on `retry`; an undefined path reads nothing. */
export function useSource<T>(path: string | undefined, parse: (data: unknown) => Parsed<T>): [Loaded<T>, () => void] {
  const [state, setState] = useState<Loaded<T>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (path === undefined) return undefined;
    let current = true;
    setState({ status: 'loading' });
    void read(path, parse).then((next) => {
      if (current) setState(next);
    });
    return (): void => {
      current = false;
    };
  }, [path, attempt]);
  return [state, () => setAttempt((n) => n + 1)];
}

/** The translations this installation can read. */
export function useTranslations(): [Loaded<readonly CorpusTranslation[]>, () => void] {
  return useSource(API.translations, parseCorpusTranslations);
}

/** The books of one translation, in canon order. */
export function useBooks(translation: string): [Loaded<readonly CorpusCanonBook[]>, () => void] {
  const [state, retry] = useSource(translation === '' ? undefined : API.canon(translation), inside('canon', parseCorpusCanon));
  return [state.status === 'ready' ? { status: 'ready', value: state.value.books } : state, retry];
}

/** One passage's text in one translation; nothing is read until the reading is complete. */
export function usePassage(translation: string, draft: ReadingDraft): Loaded<CorpusVerses> | undefined {
  const complete = readingIsValid({ ...draft, translation, compare: [] });
  const path = complete ? API.verses(translation, draft.book, draft.chapter, draft.verses) : undefined;
  const [state] = useSource(path, inside('verses', parseCorpusVerses));
  return path === undefined ? undefined : state;
}

/** Every translation's verse offset, with a way to show a newly saved one without reading them all again. */
export function useOffsets(): [ReadonlyMap<string, number>, (entry: TranslationOffsetEntry) => void] {
  const [state] = useSource(API.translationOffsets, parseTranslationOffsetList);
  const [saved, setSaved] = useState<ReadonlyMap<string, number>>(new Map());
  const loaded = state.status === 'ready' ? state.value : [];
  const offsets = new Map([...loaded.map((entry) => [entry.abbr, entry.offset] as const), ...saved]);
  return [offsets, (entry) => setSaved((before) => new Map(before).set(entry.abbr, entry.offset))];
}

/** Saves one translation's offset (P-7: `settings.manage` only); answers the refusal code, or undefined. */
export async function saveOffset(abbr: string, offset: number): Promise<string | undefined> {
  const answer = await request(API.translationOffset(abbr), { method: 'PUT', body: { offset }, csrf: csrf() ?? '' });
  return answer.ok ? undefined : answer.code;
}
