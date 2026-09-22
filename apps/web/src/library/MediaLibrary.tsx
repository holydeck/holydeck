import { t } from '../i18n.js';

import type { JSX } from 'preact';

export function MediaLibrary(): JSX.Element {
  return <h1>{t('media.title')}</h1>;
}
