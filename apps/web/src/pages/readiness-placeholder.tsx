import { t } from '../i18n.js';

import type { JSX } from 'preact';

export function ReadinessPlaceholderPage({ id }: { readonly id: string }): JSX.Element {
  return (
    <>
      <h1>{t('readiness.title')}</h1>
      <h2>{t('readiness.later.heading')}</h2>
      <p>{t('readiness.later.body')}</p>
      <p><a href={`/services/${id}`}>{t('readiness.later.back')}</a></p>
    </>
  );
}
