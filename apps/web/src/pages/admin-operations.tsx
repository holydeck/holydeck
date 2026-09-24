// The operational health report an administrator reads (spec v1c-14, OUI-02). This is the shell only: a
// permission gate and a first read of `GET /api/v1/operations/health`, so the route, the Administration
// link and the page itself exist and are gated correctly before a later pass renders each status domain
// and its findings (`operational-health.ts`'s `OperationalHealthReport`).

import { useEffect, useState } from 'preact/hooks';

import { can } from '../app-state.js';
import { t } from '../i18n.js';
import { NotFoundPage } from './not-found.js';
import { request } from '../request.js';

import type { JSX } from 'preact';

export const OPERATIONS_HEALTH_PATH = '/api/v1/operations/health';

/** The service's own operational health, by domain, as the server last measured it. */
export function AdminOperationsPage(): JSX.Element {
  const permitted = can('operations.read');
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    if (!permitted) return;
    let current = true;
    void (async () => {
      const result = await request(OPERATIONS_HEALTH_PATH);
      if (current) setLoadFailed(!result.ok);
    })();
    return () => {
      current = false;
    };
  }, [permitted]);

  if (!permitted) return <NotFoundPage />;

  return (
    <>
      <h1>{t('operations.heading')}</h1>
      {loadFailed ? <p role="alert">{t('operations.loadFailed')}</p> : null}
    </>
  );
}
