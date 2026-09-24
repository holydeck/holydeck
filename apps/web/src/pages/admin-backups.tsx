// The recorded backups an administrator manages (spec v1c-14, OUI-03). This is the shell only: a
// permission gate and a first read of `GET /api/v1/backups`, so the route, the Administration link and
// the page itself exist and are gated correctly before a later pass adds the backup list, "Back up now"
// and the restore wizard (`backup-routes.ts`/`restore-routes.ts`'s full surface).

import { useEffect, useState } from 'preact/hooks';

import { can } from '../app-state.js';
import { t } from '../i18n.js';
import { NotFoundPage } from './not-found.js';
import { request } from '../request.js';

import type { JSX } from 'preact';

export const BACKUPS_PATH = '/api/v1/backups';

/** The recorded backups the server has taken. */
export function AdminBackupsPage(): JSX.Element {
  const permitted = can('backup.manage');
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    if (!permitted) return;
    let current = true;
    void (async () => {
      const result = await request(BACKUPS_PATH);
      if (current) setLoadFailed(!result.ok);
    })();
    return () => {
      current = false;
    };
  }, [permitted]);

  if (!permitted) return <NotFoundPage />;

  return (
    <>
      <h1>{t('backups.heading')}</h1>
      {loadFailed ? <p role="alert">{t('backups.loadFailed')}</p> : null}
    </>
  );
}
