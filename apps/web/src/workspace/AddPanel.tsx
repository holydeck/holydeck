// WS-08's Add panel, in the Library slot of the workspace: one search box above a tablist of content
// sources. The tabs use manual activation — arrow keys, Home and End only move focus, Enter or Space opens
// the focused source — so a keyboard user can pass over a source without it loading. Every panel stays
// mounted, so a half-picked passage survives a look at another source. Sermon and Media arrive with Task
// 24; until then their panels say so.

import type { MessageKey } from '@holydeck/localization/messages';
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';

import { t } from '../i18n.js';
import { BibleTab } from './tabs/BibleTab.js';
import { BlankSlideTab } from './tabs/BlankSlideTab.js';
import { SongTab } from './tabs/SongTab.js';

export type AddSource = 'bible' | 'song' | 'sermon' | 'media' | 'blank';

/** Every source, in tab order. */
export const ADD_SOURCES: readonly AddSource[] = ['bible', 'song', 'sermon', 'media', 'blank'];

const LABELS: Readonly<Record<AddSource, MessageKey>> = {
  bible: 'add.tab.bible',
  song: 'add.tab.song',
  sermon: 'add.tab.sermon',
  media: 'add.tab.media',
  blank: 'add.tab.blank',
};

const tabId = (source: AddSource): string => `add-tab-${source}`;
const panelId = (source: AddSource): string => `add-panel-${source}`;

function panelFor(source: AddSource, query: string): JSX.Element {
  if (source === 'bible') return <BibleTab query={query} />;
  if (source === 'song') return <SongTab query={query} />;
  if (source === 'blank') return <BlankSlideTab />;
  return <p>{t('add.later')}</p>;
}

export interface AddPanelProps {
  /** The sources to offer; all of them unless a screen narrows it. */
  readonly tabs?: readonly AddSource[];
}

/** The search box, the source tabs and the open source's panel. */
export function AddPanel({ tabs = ADD_SOURCES }: AddPanelProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [focused, setFocused] = useState(0);

  const onKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setSelected(focused);
      return;
    }
    const last = tabs.length - 1;
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (focused === last ? 0 : focused + 1)
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (focused === 0 ? last : focused - 1)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? last
      : undefined;
    if (next === undefined) return;
    event.preventDefault();
    setFocused(next);
    const source = tabs[next];
    if (source !== undefined) document.getElementById(tabId(source))?.focus();
  };

  return (
    <div class="add-panel">
      <label for="add-search">{t('add.search')}</label>
      <input id="add-search" type="search" value={query} onInput={(event) => setQuery(event.currentTarget.value)} />
      <div role="tablist" aria-label={t('add.tabs')}>
        {tabs.map((source, index) => (
          <button
            type="button" role="tab" key={source} id={tabId(source)}
            aria-selected={selected === index} aria-controls={panelId(source)}
            tabIndex={focused === index ? 0 : -1}
            onClick={() => { setSelected(index); setFocused(index); }}
            onKeyDown={onKeyDown}
          >
            {t(LABELS[source])}
          </button>
        ))}
      </div>
      {tabs.map((source, index) => (
        <div key={source} id={panelId(source)} role="tabpanel" aria-labelledby={tabId(source)} hidden={selected !== index}>
          {panelFor(source, query)}
        </div>
      ))}
    </div>
  );
}
