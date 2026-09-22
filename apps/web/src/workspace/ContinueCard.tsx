// A returning account almost always wants the same service it left, not the dashboard's usual first
// glance at what's next — this small card offers that one link before anything else on the page.

import type { WorkspacePosition } from '@holydeck/contracts/workspace';
import type { JSX } from 'preact';

import { t } from '../i18n.js';

const enc = encodeURIComponent;

export type ContinueCardProps = {
  readonly position: WorkspacePosition | undefined;
  readonly dropped: readonly string[];
  readonly titleOf: (serviceId: string) => string | undefined;
};

/** Offers to reopen the last service (and item, if it survived) an account was viewing. */
export function ContinueCard({ position, dropped, titleOf }: ContinueCardProps): JSX.Element | null {
  const serviceId = position?.serviceId;
  if (serviceId === undefined || dropped.includes('serviceId')) return null;
  const title = titleOf(serviceId);
  if (title === undefined) return null;

  const itemSurvived = position?.itemId !== undefined && !dropped.includes('itemId');
  const href = itemSurvived ? `/services/${enc(serviceId)}?item=${enc(position?.itemId ?? '')}` : `/services/${enc(serviceId)}`;
  const somethingDropped = dropped.includes('itemId') || dropped.includes('slideId');

  return (
    <section aria-labelledby="dashboard-continue-heading">
      <h2 id="dashboard-continue-heading">{t('dashboard.continue.heading')}</h2>
      {somethingDropped ? <p>{t('dashboard.continue.dropped')}</p> : null}
      <a href={href}>{t('dashboard.continue.open', { title })}</a>
    </section>
  );
}
