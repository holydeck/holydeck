import { t } from '../i18n.js';

import type { JSX } from 'preact';

export function Workspace(): JSX.Element {
  return <h1>{t('workspace.title')}</h1>;
}
