// WS-09's slide group editor (SLID-01): a group's slides in order, each one shown or hidden, duplicated or
// moved by the server's own per-slide operations, which answer with the whole group as it now stands.
// Text, labels and new slides or blocks travel in one whole-group save 800 ms after the last input; the
// server has no create route for a single slide. A generated group takes no whole-group save — its text
// is its song's, edited there and generated again — so it keeps only the per-slide operations. The slide
// open for editing is published as `activeSlide` for the Properties panel's overrides.

import type { Slide, SlideGroupBody } from '@holydeck/contracts/slide-groups';
import type { MessageKey } from '@holydeck/localization/messages';
import type { JSX } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import { UNREADABLE_RESPONSE } from '../api.js';
import { API } from '../api-routes.js';
import { can, csrf } from '../app-state.js';
import { t } from '../i18n.js';
import { request } from '../request.js';
import { selection } from '../state/workspace-store.js';
import { readSlideGroup, type SlideGroupRecord } from '../workspace/tabs/song-sources.js';
import { LanguageBlocks } from './LanguageBlocks.js';
import { activeSlide, type ActiveSlide } from './SlideOverrides.js';
import { useAutosave } from './use-autosave.js';

const STATUS_KEYS: Readonly<Record<string, MessageKey | undefined>> = {
  pending: 'editor.saving',
  saving: 'editor.saving',
  saved: 'editor.saved',
  failed: 'editor.saveFailed',
};

type Loaded = { readonly status: 'loading' } | { readonly status: 'error'; readonly code: string } | { readonly status: 'ready' };

/** Whether every label and block has text, which the server requires before it takes a save. */
const complete = (body: SlideGroupBody): boolean =>
  body.slides.every((slide) => slide.label.trim() !== '' && slide.languageBlocks.every((block) => block.text.trim() !== ''));

/** Edits one slide group's slides and their language blocks. */
export function SlideGroupEditor({ groupId }: { readonly groupId: string }): JSX.Element {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [title, setTitle] = useState('');
  const [body, setBody] = useState<SlideGroupBody | undefined>(undefined);
  const [dirty, setDirty] = useState(false);
  const [open, setOpen] = useState<string | undefined>(undefined);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const latest = useRef<SlideGroupBody | undefined>(undefined);
  const saved = useRef<SlideGroupBody | undefined>(undefined);
  const canEdit = can('content.edit');

  const take = (record: SlideGroupRecord): void => {
    latest.current = record.body;
    saved.current = record.body;
    setTitle(record.title);
    setBody(record.body);
    setDirty(false);
  };

  useEffect(() => {
    let current = true;
    void request(API.slideGroup(groupId)).then((answer) => {
      if (!current) return;
      const record = answer.ok ? readSlideGroup(answer.data) : undefined;
      if (record === undefined) {
        setLoaded({ status: 'error', code: answer.ok ? UNREADABLE_RESPONSE : answer.code });
        return;
      }
      take(record);
      setLoaded({ status: 'ready' });
    });
    return (): void => { current = false; };
  }, [groupId]);

  const save = useCallback(async (value: SlideGroupBody | undefined): Promise<boolean> => {
    if (value === undefined) return false;
    const answer = await request(API.slideGroup(groupId), { method: 'PUT', csrf: csrf() ?? '', body: value });
    if (answer.ok) saved.current = value;
    else setRefusal(answer.code);
    return answer.ok;
  }, [groupId]);

  const custom = body?.mode === 'custom';
  const textEditable = canEdit && custom;
  const autosave = useAutosave(body, save, { enabled: dirty && textEditable && body !== undefined && complete(body) });

  const edit = (next: SlideGroupBody): void => {
    latest.current = next;
    setBody(next);
    setDirty(true);
  };

  const send: ActiveSlide['send'] = async (path, change) => {
    if (latest.current !== saved.current) await autosave.flush();
    setRefusal(undefined);
    const answer = await request(path, { ...change, csrf: csrf() ?? '' });
    const record = answer.ok ? readSlideGroup(answer.data) : undefined;
    if (record === undefined) setRefusal(answer.ok ? UNREADABLE_RESPONSE : answer.code);
    else take(record);
  };

  const openSlide = body?.slides.find((slide) => slide.id === open);
  useEffect(() => {
    activeSlide.value = body === undefined || openSlide === undefined
      ? undefined
      : { groupId, group: body, slide: openSlide, canEdit, send };
  });
  useEffect(() => () => {
    activeSlide.value = undefined;
  }, []);
  // The slide open here is where the operator is looking inside the selected item: the position writer
  // follows `selection`, so reopening the service can resume on this slide, not only on its item.
  useEffect(() => {
    const { itemId, slideId } = selection.peek();
    if (itemId === undefined || slideId === open) return;
    selection.value = open === undefined ? { itemId } : { itemId, slideId: open };
  }, [open]);

  if (loaded.status === 'loading' || body === undefined) {
    return loaded.status === 'error'
      ? <p role="alert">{t('add.error')} <code>{loaded.code}</code></p>
      : <p role="status">{t('app.loading')}</p>;
  }

  const slides = body.slides;
  const setSlide = (next: Slide): void => edit({ ...body, slides: slides.map((slide) => (slide.id === next.id ? next : slide)) });
  const move = (from: number, to: number): void => {
    const ids = slides.map((slide) => slide.id);
    const [id] = ids.splice(from, 1);
    if (id === undefined) return;
    ids.splice(to, 0, id);
    void send(API.slideOrder(groupId), { method: 'PUT', body: { slideIds: ids } });
  };
  const addSlide = (): void => {
    const slide: Slide = { id: globalThis.crypto.randomUUID(), enabled: true, label: t('slides.new', { n: slides.length + 1 }), languageBlocks: [] };
    edit({ ...body, slides: [...slides, slide] });
    setOpen(slide.id);
  };
  const status = STATUS_KEYS[autosave.state];

  return (
    <section class="slide-group-editor" aria-label={t('slides.heading')}>
      <h2>{title}</h2>
      <label>
        <input
          type="checkbox"
          checked={body.enabled}
          disabled={!canEdit}
          onChange={(event) => void send(API.slideGroupStatus(groupId), { method: 'PATCH', body: { enabled: event.currentTarget.checked } })}
        />
        {t('slides.group.enabled')}
      </label>
      {custom ? null : <p>{t('slides.generated')}</p>}
      {refusal === undefined ? null : <p role="alert">{t('add.error')} <code>{refusal}</code></p>}
      {dirty && !complete(body) ? <p>{t('slides.incomplete')}</p> : null}
      {status === undefined ? null : <p role="status">{t(status)}</p>}
      <h3>{t('slides.heading')}</h3>
      <ol>
        {slides.map((slide, index) => (
          <li key={slide.id}>
            <span>{slide.label}</span>{' '}
            <span>{slide.languageBlocks[0]?.text ?? ''}</span>
            {slide.enabled ? null : <span> {t('slides.disabled')}</span>}
            <button
              type="button"
              aria-label={t('slides.edit.slide', { n: index + 1 })}
              aria-pressed={open === slide.id}
              onClick={() => setOpen(open === slide.id ? undefined : slide.id)}
            >
              {t('slides.edit')}
            </button>
            <button type="button" disabled={!canEdit} onClick={() => void send(API.slideDuplicate(groupId, slide.id), { method: 'POST' })}>
              {t('slides.duplicate')}
            </button>
            <button
              type="button"
              disabled={!canEdit}
              onClick={() => void send(API.slide(groupId, slide.id), { method: 'PATCH', body: { enabled: !slide.enabled } })}
            >
              {t(slide.enabled ? 'slides.disable' : 'slides.enable')}
            </button>
            <button type="button" disabled={!canEdit || index === 0} onClick={() => move(index, index - 1)}>{t('slides.moveUp')}</button>
            <button type="button" disabled={!canEdit || index === slides.length - 1} onClick={() => move(index, index + 1)}>
              {t('slides.moveDown')}
            </button>
          </li>
        ))}
      </ol>
      {textEditable ? <button type="button" onClick={addSlide}>{t('slides.add')}</button> : null}
      {openSlide === undefined ? null : (
        <div>
          <label>
            {t('slides.label')}
            <input
              value={openSlide.label}
              readOnly={!textEditable}
              onInput={(event) => setSlide({ ...openSlide, label: event.currentTarget.value })}
            />
          </label>
          <LanguageBlocks groupId={groupId} slide={openSlide} textEditable={textEditable} canEdit={canEdit} onEdit={setSlide} send={send} />
        </div>
      )}
    </section>
  );
}
