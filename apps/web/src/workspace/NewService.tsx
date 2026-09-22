import { t } from '../i18n.js';

import type { JSX } from 'preact';

export function NewService(): JSX.Element {
  return <h1>{t('serviceNew.title')}</h1>;
}
