// The Add panel's Song source (WS-08, P-6): find a song, see the slides last generated from it, generate
// them again with a Slide Layout, and Insert. A song enters a service as its generated slide group pinned
// at that group's newest revision, so a song with no generated group asks to be generated first. New
// Song and Edit Song open the Song editor right here, so a missing song can be written without leaving.

import type { ServiceItem } from '@holydeck/contracts/services';
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';

import { t } from '../../i18n.js';
import { GenerateSlides } from '../../editors/LayoutPicker.js';
import { SongEditor } from '../../editors/SongEditor.js';
import { request } from '../../request.js';
import { API } from '../../api-routes.js';
import { isReadOnly } from '../../state/workspace-store.js';
import { insertAndSelect, InsertLocation, useInsertTarget } from '../InsertLocation.js';
import { NoMatch, SourceError } from './BibleTab.js';
import { generatedGroupOf, latestGroupRef, readSongRecord, useSongs, type SlideGroupRecord, type SongRecord, type Titled } from './song-sources.js';

const TAMIL_SCRIPT = /[஀-௿]/u;

/** The language a title is written in: Tamil script, else romanized Tamil. */
export const titleLang = (title: string): string => (TAMIL_SCRIPT.test(title) ? 'ta' : 'ta-Latn');

type Picked = {
  readonly song: Titled;
  readonly revision?: number;
  readonly group: SlideGroupRecord | undefined | 'loading';
};

/** The song list, the picked song's slides, generation, location and Insert. */
export function SongTab({ query }: { readonly query: string }): JSX.Element {
  const [songs, retry] = useSongs(query);
  const [picked, setPicked] = useState<Picked | undefined>(undefined);
  const [editing, setEditing] = useState<'new' | 'picked' | undefined>(undefined);
  const [target, setTarget] = useInsertTarget();
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);

  const pick = async (song: Titled): Promise<void> => {
    setPicked({ song, group: 'loading' });
    setEditing(undefined);
    setRefusal(undefined);
    const [read, group] = await Promise.all([request(API.song(song.id)), generatedGroupOf(song)]);
    const record = read.ok ? readSongRecord(read.data) : undefined;
    setPicked((current) => (current?.song.id === song.id ? { song, revision: record?.revision, group } : current));
  };

  const edited = (record: SongRecord): void => {
    setPicked((current) => {
      if (current?.song.id === record.id) return { ...current, song: { id: record.id, title: record.title }, revision: record.revision };
      return { song: { id: record.id, title: record.title }, revision: record.revision, group: undefined };
    });
    setEditing('picked');
  };

  const insert = async (): Promise<void> => {
    if (target === undefined || picked === undefined || picked.group === undefined || picked.group === 'loading') return;
    setBusy(true);
    setRefusal(undefined);
    const content = await latestGroupRef(picked.group.id);
    if (content === undefined) setRefusal('client.unreadable_response');
    else {
      const item: ServiceItem = { id: globalThis.crypto.randomUUID(), kind: 'song', title: picked.song.title, enabled: true, content };
      if (await insertAndSelect(target, item)) setTarget(undefined);
    }
    setBusy(false);
  };

  if (songs.status === 'loading') return <p role="status">{t('app.loading')}</p>;
  if (songs.status === 'error') return <SourceError code={songs.code} retry={retry} />;

  const group = picked?.group;
  const ready = group !== undefined && group !== 'loading';

  return (
    <div class="song-tab">
      <button type="button" onClick={() => { setPicked(undefined); setEditing('new'); }}>{t('song.new')}</button>
      {songs.value.length === 0 ? (query.trim() === '' ? <p>{t('song.initial')}</p> : <NoMatch />) : (
        <ul class="song-list" aria-label={t('song.list')}>
          {songs.value.map((song) => (
            <li key={song.id}>
              <button type="button" aria-pressed={picked?.song.id === song.id} onClick={() => void pick(song)}>
                <span lang={titleLang(song.title)}>{song.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing === 'new' ? <SongEditor key="new" onChange={edited} /> : null}
      {picked === undefined ? null : (
        <section class="song-picked" aria-label={picked.song.title}>
          <h3 lang={titleLang(picked.song.title)}>{picked.song.title}</h3>
          {group === 'loading' ? <p role="status">{t('app.loading')}</p> : group === undefined ? <p>{t('song.generateFirst')}</p> : (
            <>
              <h4>{t('song.preview')}</h4>
              <ol class="song-slides">
                {group.body.slides.map((slide) => <li key={slide.id}>{slide.label}</li>)}
              </ol>
            </>
          )}
          {picked.revision === undefined ? null : (
            <GenerateSlides
              songId={picked.song.id} songRevision={picked.revision} {...(ready ? { groupId: group.id } : {})}
              onGenerated={(generated) => setPicked((current) => (current === undefined ? current : { ...current, group: generated }))}
            />
          )}
          {editing === 'picked' ? null : <button type="button" onClick={() => setEditing('picked')}>{t('song.edit')}</button>}
          {editing === 'picked' ? <SongEditor key={picked.song.id} songId={picked.song.id} onChange={edited} /> : null}
        </section>
      )}
      <InsertLocation idPrefix="song-insert" value={target} onChange={setTarget} />
      <button type="button" disabled={!ready || target === undefined || isReadOnly.value || busy} onClick={() => void insert()}>
        {t('add.insert')}
      </button>
      {refusal === undefined ? null : <p role="alert">{t('add.error')} <code>{refusal}</code></p>}
    </div>
  );
}
