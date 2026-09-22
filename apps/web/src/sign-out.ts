// Ending a session is small enough to be one action, but its two expected outcomes belong together: the
// server may confirm deletion or say the session was already over. Every other refusal leaves the known
// session in place and says so through the shell, rather than navigating somebody away on an uncertain result.

import { SESSION_EXPIRED, SESSION_PATH } from '@holydeck/contracts/sessions';

import { csrf, session } from './app-state.js';
import { clearAllDrafts } from './drafts.js';
import { t } from './i18n.js';
import { request } from './request.js';
import { navigate } from './router.js';
import { say } from './status.js';

/** Ends the current session, or reports that the server could not establish that it did. */
export async function signOut(): Promise<void> {
  const result = await request(SESSION_PATH, { method: 'DELETE', csrf: csrf() ?? '' });
  clearAllDrafts();
  if (result.ok || result.code === SESSION_EXPIRED) {
    session.value = null;
    navigate('/sign-in', { replace: true });
    return;
  }
  say('assertive', t('app.signOut.failed'));
}
