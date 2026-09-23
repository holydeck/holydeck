// WS-09's Song editor: a song's titles, languages, sections and details as a form, or its raw YAML. A new
// song is created by an explicit Create; after that every change saves itself 800 ms later against the
// revision it was read at, and a save that finds a newer revision is refused rather than overwriting it
// (409) — the person reloads the latest and carries on from there. The Raw YAML tab saves through the
// server's own validation, and the form re-reads the song after it, because the server is the truth.

import { ENTITY_CONFLICT } from '@holydeck/contracts/http';
import { METADATA_KEYS, TITLE_LANGUAGE_KEYS } from '@holydeck/contracts/songs';
import type { MessageKey } from '@holydeck/localization/messages';
import type { JSX } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import { API } from '../api-routes.js';
import { csrf } from '../app-state.js';
import { t } from '../i18n.js';
import { request } from '../request.js';
import { readSongRecord, useContentLanguages, useSlideLabels, type SongRecord } from '../workspace/tabs/song-sources.js';
import { RawYamlEditor } from './RawYamlEditor.js';
import { EMPTY_SONG_FORM, fromForm, toForm, type SongForm, type SongFormSection } from './song-form.js';
import { useAutosave } from './use-autosave.js';

const STATUS_KEYS: Readonly<Record<string, MessageKey | undefined>> = {
  pending: 'editor.saving',
  saving: 'editor.saving',
  saved: 'editor.saved',
  failed: 'editor.saveFailed',
};

const METADATA_LABELS: Readonly<Record<(typeof METADATA_KEYS)[number], MessageKey>> = {
  author: 'song.metadata.author',
  copyright: 'song.metadata.copyright',
};

const moved = <T,>(list: readonly T[], from: number, to: number): T[] => {
  const next = [...list];
  const [entry] = next.splice(from, 1);
  if (entry !== undefined) next.splice(to, 0, entry);
  return next;
};

type Loaded = { readonly status: 'loading' } | { readonly status: 'error'; readonly code: string } | { readonly status: 'ready' };

export interface SongEditorProps {
  /** The song to edit; absent for a new one. */
  readonly songId?: string;
  /** Told after every create or save with the song as the server now holds it. */
  readonly onChange?: (song: SongRecord) => void;
}

/** Edits one song as a form or as raw YAML. */
export function SongEditor({ songId, onChange }: SongEditorProps): JSX.Element {
  const [id, setId] = useState(songId);
  const revision = useRef<number | undefined>(undefined);
  const [form, setForm] = useState<SongForm>(EMPTY_SONG_FORM);
  const [loaded, setLoaded] = useState<Loaded>(songId === undefined ? { status: 'ready' } : { status: 'loading' });
  const [reads, setReads] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [stale, setStale] = useState(false);
  const [tab, setTab] = useState<'form' | 'raw'>('form');
  const [rawDirty, setRawDirty] = useState(false);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const [adding, setAdding] = useState('');
  const languages = useContentLanguages();
  const labels = useSlideLabels();

  const held = (record: SongRecord): void => {
    revision.current = record.revision;
    onChange?.(record);
  };

  useEffect(() => {
    if (id === undefined || (reads === 0 && revision.current !== undefined)) return undefined;
    let current = true;
    setLoaded({ status: 'loading' });
    void request(API.song(id)).then((answer) => {
      if (!current) return;
      const record = answer.ok ? readSongRecord(answer.data) : undefined;
      if (record === undefined) {
        setLoaded({ status: 'error', code: answer.ok ? 'client.unreadable_response' : answer.code });
        return;
      }
      held(record);
      setForm(toForm(record.body));
      setDirty(false);
      setStale(false);
      setLoaded({ status: 'ready' });
    });
    return (): void => { current = false; };
  }, [reads]);

  const save = useCallback(async (value: SongForm): Promise<boolean> => {
    if (id === undefined || revision.current === undefined) return false;
    const answer = await request(API.song(id), {
      method: 'PUT', csrf: csrf() ?? '', body: { expectedRevision: revision.current, body: fromForm(value) },
    });
    const record = answer.ok ? readSongRecord(answer.data) : undefined;
    if (record !== undefined) held(record);
    if (!answer.ok && answer.code === ENTITY_CONFLICT) setStale(true);
    return record !== undefined;
  }, [id]);

  const autosave = useAutosave(form, save, { enabled: id !== undefined && dirty && !stale && tab === 'form' });

  const edit = (next: SongForm): void => {
    setForm(next);
    setDirty(true);
  };

  const title = form.titleRomanized.trim() || form.titleTamil.trim();

  const create = async (): Promise<void> => {
    setRefusal(undefined);
    const answer = await request(API.songs, { method: 'POST', csrf: csrf() ?? '', body: { title, body: fromForm(form) } });
    const record = answer.ok ? readSongRecord(answer.data) : undefined;
    if (record === undefined) {
      setRefusal(answer.ok ? 'client.unreadable_response' : answer.code);
      return;
    }
    held(record);
    setId(record.id);
    setDirty(false);
  };

  const openTab = (next: 'form' | 'raw'): void => {
    if (next === tab) return;
    if (tab === 'raw' && rawDirty && !globalThis.confirm(t('song.raw.leave'))) return;
    setRawDirty(false);
    setTab(next);
  };

  const nameOf = (key: string): string =>
    (languages.status === 'ready' ? languages.value.find((entry) => entry.key === key)?.name : undefined) ?? key;

  const setSection = (index: number, change: Partial<SongFormSection>): void =>
    edit({ ...form, sections: form.sections.map((section, at) => (at === index ? { ...section, ...change } : section)) });

  if (loaded.status === 'loading') return <p role="status">{t('app.loading')}</p>;
  if (loaded.status === 'error') return <p role="alert">{t('add.error')} <code>{loaded.code}</code></p>;

  const offered = languages.status === 'ready' ? languages.value.filter((entry) => !form.languages.includes(entry.key)) : [];
  const status = STATUS_KEYS[autosave.state];

  const formTab = (
    <div class="song-form">
      <p>
        <label for="song-title-tamil">{t('song.titleTamil')}</label>
        <input id="song-title-tamil" lang={TITLE_LANGUAGE_KEYS.tamil} value={form.titleTamil} onInput={(event) => edit({ ...form, titleTamil: event.currentTarget.value })} />
      </p>
      <p>
        <label for="song-title-romanized">{t('song.titleRomanized')}</label>
        <input id="song-title-romanized" lang={TITLE_LANGUAGE_KEYS.romanized} value={form.titleRomanized} onInput={(event) => edit({ ...form, titleRomanized: event.currentTarget.value })} />
      </p>
      <fieldset>
        <legend>{t('song.languages')}</legend>
        <ol>
          {form.languages.map((key, index) => (
            <li key={key}>
              {nameOf(key)}{' '}
              <button type="button" disabled={index === 0} onClick={() => edit({ ...form, languages: moved(form.languages, index, index - 1) })}>
                {t('song.language.up', { language: nameOf(key) })}
              </button>
              <button type="button" disabled={index === form.languages.length - 1} onClick={() => edit({ ...form, languages: moved(form.languages, index, index + 1) })}>
                {t('song.language.down', { language: nameOf(key) })}
              </button>
              <button type="button" onClick={() => edit({ ...form, languages: form.languages.filter((entry) => entry !== key) })}>
                {t('song.language.remove', { language: nameOf(key) })}
              </button>
            </li>
          ))}
        </ol>
        {offered.length === 0 ? null : (
          <p>
            <label for="song-language-new">{t('song.language.pick')}</label>
            <select id="song-language-new" value={adding || offered[0]?.key} onChange={(event) => setAdding(event.currentTarget.value)}>
              {offered.map((entry) => <option key={entry.key} value={entry.key}>{entry.name}</option>)}
            </select>
            <button type="button" onClick={() => {
              const key = offered.some((entry) => entry.key === adding) ? adding : offered[0]?.key;
              if (key !== undefined) edit({ ...form, languages: [...form.languages, key] });
              setAdding('');
            }}>
              {t('song.language.add')}
            </button>
          </p>
        )}
      </fieldset>
      <fieldset>
        <legend>{t('song.sections')}</legend>
        <datalist id="song-labels">{labels.map((label) => <option key={label} value={label} />)}</datalist>
        {form.sections.map((section, index) => (
          <fieldset key={section.id} class="song-section">
            <legend>{t('song.section', { n: index + 1 })}</legend>
            <p>
              <label for={`song-section-${section.id}-label`}>{t('song.section.label')}</label>
              <input id={`song-section-${section.id}-label`} list="song-labels" value={section.label} onInput={(event) => setSection(index, { label: event.currentTarget.value })} />
            </p>
            <p>
              <label for={`song-section-${section.id}-repeat`}>{t('song.section.repeat')}</label>
              <input
                id={`song-section-${section.id}-repeat`} type="number" min={1} step={1} value={section.repeat}
                onChange={(event) => {
                  const next = Number(event.currentTarget.value);
                  setSection(index, { repeat: Number.isInteger(next) && next >= 1 ? next : 1 });
                }}
              />
            </p>
            {form.languages.map((key) => (
              <p key={key}>
                <label for={`song-section-${section.id}-${key}`}>{t('song.section.text', { language: nameOf(key) })}</label>
                <textarea
                  id={`song-section-${section.id}-${key}`} lang={key} value={section.text[key] ?? ''}
                  onInput={(event) => setSection(index, { text: { ...section.text, [key]: event.currentTarget.value } })}
                />
              </p>
            ))}
            <button type="button" onClick={() => edit({ ...form, sections: form.sections.filter((_, at) => at !== index) })}>
              {t('song.section.remove', { n: index + 1 })}
            </button>
          </fieldset>
        ))}
        <button type="button" onClick={() => edit({ ...form, sections: [...form.sections, { id: globalThis.crypto.randomUUID(), label: '', repeat: 1, text: {} }] })}>
          {t('song.section.add')}
        </button>
      </fieldset>
      <fieldset>
        <legend>{t('song.metadata')}</legend>
        {METADATA_KEYS.map((key) => (
          <p key={key}>
            <label for={`song-metadata-${key}`}>{t(METADATA_LABELS[key])}</label>
            <input id={`song-metadata-${key}`} value={form.metadata[key] ?? ''} onInput={(event) => edit({ ...form, metadata: { ...form.metadata, [key]: event.currentTarget.value } })} />
          </p>
        ))}
      </fieldset>
      <p>
        {t('song.provenance')}:{' '}
        {form.provenance.source === 'manual' ? t('song.provenance.manual')
          : t('song.provenance.import', { importer: form.provenance.importer, date: form.provenance.importedAt.slice(0, 10) })}
      </p>
      {id === undefined ? (
        <button type="button" disabled={title === ''} onClick={() => void create()}>{t('song.create')}</button>
      ) : null}
    </div>
  );

  return (
    <section class="song-editor" aria-label={title === '' ? t('song.new') : title}>
      <div role="tablist" aria-label={t('song.editor')}>
        <button type="button" role="tab" id="song-tab-form" aria-selected={tab === 'form'} aria-controls="song-panel" onClick={() => openTab('form')}>
          {t('song.form')}
        </button>
        <button type="button" role="tab" id="song-tab-raw" aria-selected={tab === 'raw'} aria-controls="song-panel" disabled={id === undefined} onClick={() => openTab('raw')}>
          {t('song.raw')}
        </button>
      </div>
      {stale ? (
        <div role="alert" class="song-stale">
          <p>{t('song.stale')}</p>
          <button type="button" onClick={() => setReads((count) => count + 1)}>{t('song.reload')}</button>
        </div>
      ) : null}
      {refusal === undefined ? null : <p role="alert">{t('add.error')} <code>{refusal}</code></p>}
      {status === undefined ? null : <p role="status">{t(status)}</p>}
      <div id="song-panel" role="tabpanel" aria-labelledby={tab === 'form' ? 'song-tab-form' : 'song-tab-raw'}>
        {tab === 'raw' && id !== undefined
          ? <RawYamlEditor songId={id} onDirty={setRawDirty} onSaved={() => setReads((count) => count + 1)} />
          : formTab}
      </div>
    </section>
  );
}
