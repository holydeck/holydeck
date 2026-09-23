// One slide's language blocks (LANG-01): the same line in each language, in the order the slide shows
// them. Duplicating and reordering a block are their own server operations and work on any group; the
// text itself and a new block travel in the group's whole-body save, which only a custom group takes —
// a generated group's text belongs to its song, so there it is shown read-only.

import type { Slide } from '@holydeck/contracts/slide-groups';
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';

import { API } from '../api-routes.js';
import { t } from '../i18n.js';
import { useContentLanguages } from '../workspace/tabs/song-sources.js';
import type { ActiveSlide } from './SlideOverrides.js';

export interface LanguageBlocksProps {
  readonly groupId: string;
  readonly slide: Slide;
  /** Whether the text and the block list may change through the whole-group save. */
  readonly textEditable: boolean;
  /** Whether the person may change the group at all. */
  readonly canEdit: boolean;
  /** Takes the slide with its text or blocks changed, to save with the group. */
  readonly onEdit: (slide: Slide) => void;
  readonly send: ActiveSlide['send'];
}

/** Edits, adds, duplicates and reorders one slide's language blocks. */
export function LanguageBlocks({ groupId, slide, textEditable, canEdit, onEdit, send }: LanguageBlocksProps): JSX.Element {
  const languages = useContentLanguages();
  const [adding, setAdding] = useState('');
  const blocks = slide.languageBlocks;
  const choices = languages.status === 'ready' ? languages.value : [];
  const nameOf = (key: string): string => choices.find((entry) => entry.key === key)?.name ?? key;

  const setText = (blockId: string, text: string): void =>
    onEdit({ ...slide, languageBlocks: blocks.map((block) => (block.id === blockId ? { ...block, text } : block)) });

  const move = (from: number, to: number): void => {
    const ids = blocks.map((block) => block.id);
    const [id] = ids.splice(from, 1);
    if (id === undefined) return;
    ids.splice(to, 0, id);
    void send(API.languageBlockOrder(groupId, slide.id), { method: 'PUT', body: { blockIds: ids } });
  };

  const add = (): void => {
    if (adding === '') return;
    onEdit({ ...slide, languageBlocks: [...blocks, { id: globalThis.crypto.randomUUID(), languageKey: adding, text: '' }] });
    setAdding('');
  };

  return (
    <section aria-label={t('slides.blocks')}>
      <h4>{t('slides.blocks')}</h4>
      {blocks.map((block, index) => {
        const name = nameOf(block.languageKey);
        return (
          <fieldset key={block.id}>
            <legend>{name}</legend>
            <textarea
              aria-label={t('slides.block.text', { language: name })}
              lang={block.languageKey}
              value={block.text}
              readOnly={!textEditable}
              onInput={(event) => setText(block.id, event.currentTarget.value)}
            />
            <button type="button" disabled={!canEdit} onClick={() => void send(API.languageBlockDuplicate(groupId, slide.id, block.id), { method: 'POST' })}>
              {t('slides.duplicate')}
            </button>
            <button type="button" disabled={!canEdit || index === 0} onClick={() => move(index, index - 1)}>{t('slides.moveUp')}</button>
            <button type="button" disabled={!canEdit || index === blocks.length - 1} onClick={() => move(index, index + 1)}>
              {t('slides.moveDown')}
            </button>
          </fieldset>
        );
      })}
      {textEditable ? (
        <div>
          <label>
            {t('slides.block.language')}
            <select value={adding} onChange={(event) => setAdding(event.currentTarget.value)}>
              <option value="" />
              {choices.map((entry) => <option key={entry.key} value={entry.key}>{entry.name}</option>)}
            </select>
          </label>
          <button type="button" disabled={adding === ''} onClick={add}>{t('slides.block.add')}</button>
        </div>
      ) : null}
    </section>
  );
}
