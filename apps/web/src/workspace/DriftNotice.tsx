// The revision-drift notice (ADR 0005): never revises an item on its own, only on this explicit click.

import type { JSX } from 'preact';

import { API } from '../api-routes.js';
import { t } from '../i18n.js';
import { drift, isReadOnly, mutate, service } from '../state/workspace-store.js';

export function DriftNotice({ itemId }: { readonly itemId: string }): JSX.Element | null {
  const view = service.value;
  const entry = drift.value.find((candidate) => candidate.itemId === itemId);
  if (view === undefined || entry === undefined) return null;

  const revise = (): void => {
    void mutate(API.itemAction(view.id, itemId, 'revise'), { method: 'POST', body: { revision: entry.latestRevision } }, itemId);
  };

  return (
    <span class="drift-notice">
      {t('drift.available')}
      <button type="button" disabled={isReadOnly.value} onClick={revise}>
        {t('drift.update', { n: entry.latestRevision })}
      </button>
    </span>
  );
}
