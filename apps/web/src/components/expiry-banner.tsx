// A session close to its idle deadline needs an in-page action as well as the assertive live message:
// this small banner keeps the warning visible until the operator touches the session again, without
// blocking the work that activity is meant to preserve.

import { expiryWarning } from '../app-state.js';
import { t } from '../i18n.js';
import { staySignedIn } from '../session-timer.js';

import type { JSX } from 'preact';

/** Shows the remaining session time and the one action that asks the server to extend its idle window. */
export function ExpiryBanner(): JSX.Element | null {
  const warning = expiryWarning.value;
  if (warning === undefined) return null;
  return (
    <div class="expiry-banner" role="region" aria-label={t('session.stay')}>
      <p>{t('session.expiring', { minutes: warning.minutes })}</p>
      <button type="button" onClick={() => void staySignedIn()}>{t('session.stay')}</button>
    </div>
  );
}
