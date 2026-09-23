// WS-13's Content Library at `/library`: one search over songs, sermons and slide groups, narrowed by type
// on the server and by recent use here (P-17: changed within 30 days — the server keeps no read log), with
// archived entries only on request. Picking an entry shows its detail; Open puts the matching editor in
// that same pane and records `?open=<id>` in the address so a reload comes back to it — a sermon opens as a
// read-only outline (D03-5). The list is read again whenever the window regains focus and after an editor
// saves, so work done in another tab shows up without a manual refresh.

import { LIBRARY_KINDS, type LibraryKind } from '@holydeck/contracts/library';
import { isRecord, type Parsed } from '@holydeck/contracts/problems';
import type { MessageKey } from '@holydeck/localization/messages';
import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { UNREADABLE_RESPONSE } from '../api.js';
import { API, type HistoryKind } from '../api-routes.js';
import { SlideGroupEditor } from '../editors/SlideGroupEditor.js';
import { SongEditor } from '../editors/SongEditor.js';
import { t } from '../i18n.js';
import { request } from '../request.js';
import { useSource } from '../workspace/tabs/bible-sources.js';
import { NoMatch, SourceError } from '../workspace/tabs/BibleTab.js';
import { readSermon, type SermonPick } from '../workspace/tabs/SermonTab.js';
import { titleLang } from '../workspace/tabs/SongTab.js';

/** One library row as the list shows it. */
export type LibraryEntry = {
  readonly id: string;
  readonly kind: LibraryKind;
  readonly title: string;
  readonly updatedAt: string;
  readonly archived: boolean;
};

/** The types the filter offers, besides All. */
export const LIBRARY_FILTER_KINDS = ['song', 'sermon', 'slideGroup'] as const satisfies readonly LibraryKind[];

const KIND_KEYS: Readonly<Record<LibraryKind, MessageKey>> = {
  song: 'library.type.song',
  sermon: 'library.type.sermon',
  slideGroup: 'library.type.slideGroup',
  reading: 'library.type.reading',
  reusableSlide: 'library.type.reusableSlide',
};

/** Recent use, in the absence of a read log: changed within this many days. */
export const RECENT_DAYS = 30;

const DAY_MS = 86_400_000;

const HISTORY_KINDS: readonly string[] = ['song', 'sermon', 'slideGroup'] satisfies readonly HistoryKind[];

const isKind = (value: unknown): value is LibraryKind => LIBRARY_KINDS.includes(value as LibraryKind);

function readEntry(value: unknown): LibraryEntry | undefined {
  const stamp = isRecord(value) ? value['stamp'] : undefined;
  if (!isRecord(value) || !isRecord(stamp)) return undefined;
  const { id, kind, updatedAt, archivedAt } = stamp;
  const title = value['title'];
  if (typeof id !== 'string' || !isKind(kind) || typeof title !== 'string') return undefined;
  return { id, kind, title, updatedAt: typeof updatedAt === 'string' ? updatedAt : '', archived: typeof archivedAt === 'string' };
}

/** Library rows (`{stamp: {id, kind, updatedAt, archivedAt?}, title}`); one unreadable row fails the list. */
export function readLibraryEntries(data: unknown): Parsed<readonly LibraryEntry[]> {
  const fail: Parsed<never> = { ok: false, problems: [{ path: 'library', code: UNREADABLE_RESPONSE, message: 'unreadable' }] };
  if (!Array.isArray(data)) return fail;
  const entries = data.map(readEntry);
  return entries.every((entry) => entry !== undefined) ? { ok: true, value: entries } : fail;
}

/** Whether an entry changed within the last `RECENT_DAYS` days of `now`. */
export const isRecent = (entry: LibraryEntry, now: number): boolean => {
  const at = Date.parse(entry.updatedAt);
  return Number.isFinite(at) && now - at <= RECENT_DAYS * DAY_MS;
};

const openParam = (): string | undefined => new URLSearchParams(globalThis.location?.search ?? '').get('open') ?? undefined;

const setOpenParam = (id: string | undefined): void => {
  const { pathname } = globalThis.location;
  globalThis.history.replaceState(globalThis.history.state, '', id === undefined ? pathname : `${pathname}?open=${encodeURIComponent(id)}`);
};

function Revisions({ entry }: { readonly entry: LibraryEntry }): JSX.Element | null {
  const [count, setCount] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!HISTORY_KINDS.includes(entry.kind)) return undefined;
    let current = true;
    void request(API.contentHistory(entry.kind as HistoryKind, entry.id)).then((answer) => {
      if (current && answer.ok && Array.isArray(answer.data)) setCount(answer.data.length);
    });
    return (): void => { current = false; };
  }, [entry.id, entry.kind]);
  return count === undefined || count === 0 ? null : <p>{t('library.revision', { n: count })}</p>;
}

function SermonOutline({ id }: { readonly id: string }): JSX.Element {
  const [sermon, setSermon] = useState<SermonPick | undefined | 'loading' | { readonly code: string }>('loading');
  useEffect(() => {
    let current = true;
    void request(API.sermon(id)).then((answer) => {
      if (!current) return;
      const read = answer.ok ? readSermon(answer.data) : undefined;
      setSermon(read ?? { code: answer.ok ? UNREADABLE_RESPONSE : answer.code });
    });
    return (): void => { current = false; };
  }, [id]);
  if (sermon === 'loading' || sermon === undefined) return <p role="status">{t('app.loading')}</p>;
  if ('code' in sermon) return <p role="alert">{t('add.error')} <code>{sermon.code}</code></p>;
  return (
    <section aria-label={t('sermon.outline')}>
      <h3>{t('sermon.outline')}</h3>
      <ol class="sermon-outline">
        {sermon.outline.map((line, index) => (
          <li key={index}>{line.passage}{line.point === undefined ? null : <> — <span lang={sermon.lang}>{line.point}</span></>}</li>
        ))}
      </ol>
    </section>
  );
}

function Opened({ entry, onSaved }: { readonly entry: LibraryEntry; readonly onSaved: () => void }): JSX.Element | null {
  if (entry.kind === 'song') return <SongEditor key={entry.id} songId={entry.id} onChange={onSaved} />;
  if (entry.kind === 'slideGroup') return <SlideGroupEditor key={entry.id} groupId={entry.id} />;
  if (entry.kind === 'sermon') return <SermonOutline key={entry.id} id={entry.id} />;
  return null;
}

const OPENABLE: readonly LibraryKind[] = ['song', 'slideGroup', 'sermon'];

/** The Content Library screen: search, filters, results and the picked entry's detail. */
export function ContentLibrary(): JSX.Element {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<LibraryKind | ''>('');
  const [recent, setRecent] = useState(false);
  const [archived, setArchived] = useState(false);
  const [picked, setPicked] = useState<LibraryEntry | undefined>(undefined);
  const [opened, setOpened] = useState<string | undefined>(openParam);
  const q = query.trim();
  const [entries, retry] = useSource(
    API.library({ ...(kind === '' ? {} : { kind }), ...(q === '' ? {} : { q }), ...(archived ? { archived } : {}) }),
    readLibraryEntries,
  );

  useEffect(() => {
    globalThis.addEventListener('focus', retry);
    return (): void => globalThis.removeEventListener('focus', retry);
  });

  useEffect(() => {
    const id = openParam();
    if (id === undefined) return undefined;
    let current = true;
    void request(API.libraryEntry(id)).then((answer) => {
      const entry = answer.ok ? readEntry(answer.data) : undefined;
      if (current && entry !== undefined) setPicked((now) => now ?? entry);
    });
    return (): void => { current = false; };
  }, []);

  const open = (entry: LibraryEntry | undefined): void => {
    setOpened(entry?.id);
    setOpenParam(entry?.id);
  };
  const choose = (entry: LibraryEntry): void => {
    setPicked(entry);
    if (opened !== undefined && opened !== entry.id) open(undefined);
  };

  const filtering = q !== '' || kind !== '' || recent || archived;
  const now = Date.now();
  const shown = entries.status === 'ready' ? entries.value.filter((entry) => !recent || isRecent(entry, now)) : [];

  return (
    <div class="content-library">
      <h1>{t('library.title')}</h1>
      <div class="library-filters">
        <label for="library-search">{t('library.search')}</label>
        <input id="library-search" type="search" value={query} onInput={(event) => setQuery(event.currentTarget.value)} />
        <label for="library-type">{t('library.type')}</label>
        <select id="library-type" value={kind} onChange={(event) => setKind(event.currentTarget.value as LibraryKind | '')}>
          <option value="">{t('library.type.all')}</option>
          {LIBRARY_FILTER_KINDS.map((value) => <option key={value} value={value}>{t(KIND_KEYS[value])}</option>)}
        </select>
        <label>
          <input type="checkbox" checked={recent} onChange={(event) => setRecent(event.currentTarget.checked)} />
          {t('library.recent')}
        </label>
        <label>
          <input type="checkbox" checked={archived} onChange={(event) => setArchived(event.currentTarget.checked)} />
          {t('library.archived')}
        </label>
      </div>
      {entries.status === 'loading' ? <p role="status">{t('app.loading')}</p>
        : entries.status === 'error' ? <SourceError code={entries.code} retry={retry} />
        : shown.length === 0 ? (filtering ? <NoMatch /> : (
          <div class="library-empty">
            <h2>{t('library.empty.heading')}</h2>
            <p>{t('library.empty.body')}</p>
          </div>
        )) : (
          <ul class="library-list" aria-label={t('library.results')}>
            {shown.map((entry) => (
              <li key={entry.id}>
                <button type="button" aria-pressed={picked?.id === entry.id} onClick={() => choose(entry)}>
                  <span class="truncate" lang={titleLang(entry.title)} title={entry.title}>{entry.title}</span>{' '}
                  <span>{t(KIND_KEYS[entry.kind])}</span>
                  {entry.archived ? <span> {t('library.archivedState')}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      {picked === undefined ? null : (
        <section class="library-detail" aria-label={picked.title}>
          <h2 lang={titleLang(picked.title)}>{picked.title}</h2>
          <p>{t(KIND_KEYS[picked.kind])}{picked.archived ? ` · ${t('library.archivedState')}` : ''}</p>
          <Revisions entry={picked} />
          {OPENABLE.includes(picked.kind) && opened !== picked.id
            ? <button type="button" onClick={() => open(picked)}>{t('library.open')}</button> : null}
          {opened === picked.id ? <Opened entry={picked} onSaved={retry} /> : null}
        </section>
      )}
    </div>
  );
}
