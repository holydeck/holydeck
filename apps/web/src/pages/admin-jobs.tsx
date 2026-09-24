// The background job queue an administrator watches (spec v1c-14, OUI-01). This is the shell only: a
// permission gate and a first read of `GET /api/v1/jobs`, so the route, the Administration link and the
// page itself exist and are gated correctly before a later pass adds the filters, summary counts and
// requeue action (`job-routes.ts`'s full surface).

import { useEffect, useState } from 'preact/hooks';

import { can } from '../app-state.js';
import { t } from '../i18n.js';
import { NotFoundPage } from './not-found.js';
import { request } from '../request.js';

import type { JSX } from 'preact';

export const JOBS_PATH = '/api/v1/jobs';

/** The queued and running background jobs the server tracks. */
export function AdminJobsPage(): JSX.Element {
  const permitted = can('jobs.view');
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    if (!permitted) return;
    let current = true;
    void (async () => {
      const result = await request(JOBS_PATH);
      if (current) setLoadFailed(!result.ok);
    })();
    return () => {
      current = false;
    };
  }, [permitted]);

  if (!permitted) return <NotFoundPage />;

  return (
    <>
      <h1>{t('jobs.heading')}</h1>
      {loadFailed ? <p role="alert">{t('jobs.loadFailed')}</p> : null}
    </>
  );
}
