// The Details tab's Properties view: the service's own facts first, always read-only here because a
// title, date or site can only ever change through `NewService`'s duplicate flow or `/schedule` (P-9),
// then whatever an item or box under selection adds beneath it (later tasks).

import type { ComponentChildren, JSX } from 'preact';

import { locale } from '../app-state.js';
import { t } from '../i18n.js';
import { drift, selection, service } from '../state/workspace-store.js';
import { DriftNotice } from './DriftNotice.js';
import { findItem } from './service-data.js';

const dateOf = (date: string): string =>
  new Intl.DateTimeFormat(locale.value, { dateStyle: 'full', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));

/** The service summary, read-only, followed by whatever properties the current selection adds. */
export function PropertiesPanel({ children }: { readonly children?: ComponentChildren }): JSX.Element | null {
  const view = service.value;
  if (view === undefined) return null;
  const itemId = selection.value.itemId;
  const item = itemId === undefined ? undefined : findItem(view, itemId);
  const entry = itemId === undefined ? undefined : drift.value.find((candidate) => candidate.itemId === itemId);
  return (
    <div>
      <h2>{view.title}</h2>
      <p>{dateOf(view.date)}</p>
      <p>{view.site}</p>
      <p>{t(`service.state.${view.state}`)}</p>
      {item === undefined || entry === undefined ? null : (
        <div>
          <table>
            <thead>
              <tr>
                <th scope="col">{t('drift.compare.pinned', { n: item.content?.revision ?? 0 })}</th>
                <th scope="col">{t('drift.compare.latest', { n: entry.latestRevision })}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{item.title}</td>
                <td>{item.title}</td>
              </tr>
            </tbody>
          </table>
          <p>{t('drift.compare.later')}</p>
          <DriftNotice itemId={item.id} />
        </div>
      )}
      {children}
    </div>
  );
}
