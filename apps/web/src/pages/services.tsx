// Where a signed-in person lands (`/services`). Service planning is spec 03's; until then the page says so
// and points at the one way to a service that already works, its own link.

import { t } from '../i18n.js';

import type { JSX } from 'preact';

/** The services landing page. */
export function ServicesPage(): JSX.Element {
  return (
    <>
      <h1>{t('app.services.title')}</h1>
      <p>{t('app.services.empty')}</p>
    </>
  );
}
