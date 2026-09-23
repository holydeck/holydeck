// The Add panel's Sermon source (WS-08): find a sermon in the library, see its outline — each passage with
// the point it carries — and Insert it pinned at its current revision. Sermons are written in their own
// raw editor, so this tab offers no edit control; it only chooses what the service shows.

import { isRecord } from '@holydeck/contracts/problems';
import type { ServiceItem } from '@holydeck/contracts/services';
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';

import { API } from '../../api-routes.js';
import { t } from '../../i18n.js';
import { request } from '../../request.js';
import { isReadOnly } from '../../state/workspace-store.js';
import { insertAndSelect, InsertLocation, useInsertTarget } from '../InsertLocation.js';
import { useSource } from './bible-sources.js';
import { NoMatch, SourceError } from './BibleTab.js';
import { addressOf, readTitled, type Titled } from './song-sources.js';
import { titleLang } from './SongTab.js';

/** One outline line: a passage and the point it carries, when the sermon gives one. */
export type OutlineLine = { readonly passage: string; readonly point?: string };

/** A sermon answer as this tab needs it, or undefined when it is not one. */
export type SermonPick = {
  readonly id: string;
  readonly title: string;
  readonly revision: number;
  readonly body: unknown;
  readonly outline: readonly OutlineLine[];
  /** The content language the points are written in. */
  readonly lang?: string;
};

const verseList = (verses: unknown): string =>
  Array.isArray(verses) ? verses.filter((verse) => typeof verse === 'number').join(',') : '';

/** Reads `{stamp, title, revision, body: {sermon: {entries}, languages}}`; points come from the first language. */
export function readSermon(data: unknown): SermonPick | undefined {
  if (!isRecord(data) || !isRecord(data['stamp']) || !isRecord(data['body'])) return undefined;
  const { stamp, title, revision, body } = data;
  const id = stamp['id'];
  const file = body['sermon'];
  if (typeof id !== 'string' || typeof title !== 'string' || typeof revision !== 'number' || !isRecord(file)) return undefined;
  const entries = Array.isArray(file['entries']) ? file['entries'] : [];
  const languages = isRecord(body['languages']) ? Object.entries(body['languages']) : [];
  const [lang, first] = languages.find((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1])) ?? [];
  const points = first !== undefined && Array.isArray(first['points']) ? first['points'] : [];
  const outline = entries.filter(isRecord).map((entry, index): OutlineLine => {
    const point = points[index];
    const passage = `${String(entry['book'])} ${String(entry['chapter'])}:${verseList(entry['verses'])}`;
    return typeof point === 'string' ? { passage, point } : { passage };
  });
  return { id, title, revision, body, outline, ...(lang === undefined ? {} : { lang }) };
}

/** The sermon list, the picked sermon's outline, location and Insert. */
export function SermonTab({ query }: { readonly query: string }): JSX.Element {
  const needle = query.trim();
  const [sermons, retry] = useSource(API.library({ kind: 'sermon', ...(needle === '' ? {} : { q: needle }) }), readTitled);
  const [picked, setPicked] = useState<{ readonly row: Titled; readonly sermon: SermonPick | undefined | 'loading' } | undefined>(undefined);
  const [target, setTarget] = useInsertTarget();
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);

  const pick = async (row: Titled): Promise<void> => {
    setPicked({ row, sermon: 'loading' });
    setRefusal(undefined);
    const answer = await request(API.sermon(row.id));
    const sermon = answer.ok ? readSermon(answer.data) : undefined;
    if (sermon === undefined) setRefusal(answer.ok ? 'client.unreadable_response' : answer.code);
    setPicked((current) => (current?.row.id === row.id ? { row, sermon } : current));
  };

  const insert = async (): Promise<void> => {
    const sermon = picked?.sermon;
    if (target === undefined || sermon === undefined || sermon === 'loading') return;
    setBusy(true);
    const item: ServiceItem = {
      id: globalThis.crypto.randomUUID(), kind: 'sermon', title: sermon.title, enabled: true,
      content: { id: sermon.id, revision: sermon.revision, hash: await addressOf(sermon.body) },
    };
    if (await insertAndSelect(target, item)) setTarget(undefined);
    setBusy(false);
  };

  if (sermons.status === 'loading') return <p role="status">{t('app.loading')}</p>;
  if (sermons.status === 'error') return <SourceError code={sermons.code} retry={retry} />;

  const sermon = picked?.sermon;
  const ready = sermon !== undefined && sermon !== 'loading';

  return (
    <div class="sermon-tab">
      {sermons.value.length === 0 ? (needle === '' ? <p>{t('sermon.initial')}</p> : <NoMatch />) : (
        <ul class="sermon-list" aria-label={t('sermon.list')}>
          {sermons.value.map((row) => (
            <li key={row.id}>
              <button type="button" aria-pressed={picked?.row.id === row.id} onClick={() => void pick(row)}>
                <span class="truncate" lang={titleLang(row.title)} title={row.title}>{row.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {picked === undefined ? null : (
        <section class="sermon-picked" aria-label={picked.row.title}>
          <h3 lang={titleLang(picked.row.title)}>{picked.row.title}</h3>
          {sermon === 'loading' ? <p role="status">{t('app.loading')}</p> : sermon === undefined ? null : (
            <>
              <h4>{t('sermon.outline')}</h4>
              <ol class="sermon-outline">
                {sermon.outline.map((line, index) => (
                  <li key={index}>{line.passage}{line.point === undefined ? null : <> — <span lang={sermon.lang}>{line.point}</span></>}</li>
                ))}
              </ol>
            </>
          )}
        </section>
      )}
      <InsertLocation idPrefix="sermon-insert" value={target} onChange={setTarget} />
      <button type="button" disabled={!ready || target === undefined || isReadOnly.value || busy} onClick={() => void insert()}>
        {t('add.insert')}
      </button>
      {refusal === undefined ? null : <p role="alert">{t('add.error')} <code>{refusal}</code></p>}
    </div>
  );
}
