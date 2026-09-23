// The Details tab's Properties view: the service's own facts first, always read-only here because a
// title, date or site can only ever change through `NewService`'s duplicate flow or `/schedule` (P-9),
// then whatever an item or box under selection adds beneath it — the Custom Slide canvas's selected box
// among them, and the slide group editor's open slide with its Layout and background overrides.

import type { ComponentChildren, JSX } from 'preact';

import type { ServiceItem } from '@holydeck/contracts/services';

import type { HistoryKind } from '../api-routes.js';
import { locale } from '../app-state.js';
import { BoxProperties } from '../editors/BoxProperties.js';
import { SlideOverrides } from '../editors/SlideOverrides.js';
import { t } from '../i18n.js';
import { drift, selection, service } from '../state/workspace-store.js';
import { ContentCompare } from './ContentCompare.js';
import { DriftNotice } from './DriftNotice.js';
import { OutputProfile } from './OutputProfile.js';
import { findItem } from './service-data.js';

const dateOf = (date: string): string =>
  new Intl.DateTimeFormat(locale.value, { dateStyle: 'full', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));

const HISTORY_KINDS: Partial<Record<ServiceItem['kind'], HistoryKind>> = { song: 'song', sermon: 'sermon', 'slide-group': 'slideGroup' };

/** The service summary, read-only, followed by whatever properties the current selection adds. */
export function PropertiesPanel({ children }: { readonly children?: ComponentChildren }): JSX.Element | null {
  const view = service.value;
  if (view === undefined) return null;
  const itemId = selection.value.itemId;
  const item = itemId === undefined ? undefined : findItem(view, itemId);
  const entry = itemId === undefined ? undefined : drift.value.find((candidate) => candidate.itemId === itemId);
  const compareKind = item === undefined ? undefined : HISTORY_KINDS[item.kind];
  return (
    <div>
      <h2>{view.title}</h2>
      <p>{dateOf(view.date)}</p>
      <p>{view.site}</p>
      <p>{t(`service.state.${view.state}`)}</p>
      {itemId === undefined ? <OutputProfile /> : null}
      {item === undefined || entry === undefined ? null : (
        <div>
          {compareKind === undefined || item.content === undefined ? null : (
            <ContentCompare
              key={item.id}
              kind={compareKind}
              contentId={item.content.id}
              pinned={item.content.revision}
              latest={entry.latestRevision}
            />
          )}
          <DriftNotice itemId={item.id} />
        </div>
      )}
      <BoxProperties />
      <SlideOverrides />
      {children}
    </div>
  );
}
