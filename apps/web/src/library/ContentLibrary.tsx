import { t } from '../i18n.js';

import type { JSX } from 'preact';

export function ContentLibrary(): JSX.Element {
  return <h1>{t('library.title')}</h1>;
}
