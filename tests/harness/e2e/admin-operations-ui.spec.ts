// The four new admin pages this milestone added (OUI-01..05: Jobs, Operations, Backups, notification
// preferences) proved reachable, translated and free of automated accessibility violations, plus the
// happy-path actions each one exists for: requeuing a failed job, backing the deployment up, and the
// service page's run review/recap once a run has ended. Both tests mutate or depend on shared stack
// state (a service, a run, a job, a backup record, the account's own session list), the same reason
// `collaboration.spec.ts`'s journeys run once rather than per form factor.

import { randomBytes } from 'node:crypto';

import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { CSRF_HEADER } from '@holydeck/contracts/sessions';
import { translate } from '@holydeck/localization/messages';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { signInWithControlTo } from '../src/identity.js';
import { claimOrSignIn, signOutThroughPage } from './journey.js';

import type { SignedIn } from '../src/identity.js';
import type { TestInfo } from '@playwright/test';

const en = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]): string =>
  translate('en', key, params);

const desktopOnly = (testInfo: TestInfo): void => {
  test.skip(testInfo.project.name !== 'desktop', 'one shared stack; these journeys run once, not per form factor');
};

// None of these have a contracts-package export the way `LIVE_PATH` does — `run-routes.ts`/
// `service-routes.ts`/`job-routes.ts`/`backup-routes.ts`'s own local constants, named here the literal
// way `live-run.spec.ts` already names the ones it has no export for either.
const SERVICE_PATH = '/api/v1/services';
const preparePath = (serviceId: string): string => `/api/v1/services/${serviceId}/prepare`;
const RUN_PATH = '/api/v1/runs';
const MEDIA_PATH = '/api/v1/media';
const JOBS_PATH = '/api/v1/jobs';
const BACKUPS_PATH = '/api/v1/backups';

// Fastify's JSON body parser refuses an empty body sent with `content-type: application/json` (the run
// `.../end` route takes none), so that header is only ever added alongside an actual body — the same
// convention `collaboration.spec.ts`'s own `request` helper uses.
const jsonHeaders = (base: string, session: SignedIn, hasBody: boolean): Record<string, string> => ({
  origin: base,
  cookie: session.cookie,
  [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
  [CSRF_HEADER]: session.csrf,
  ...(hasBody ? { 'content-type': 'application/json' } : {}),
});

const apiRequest = async (base: string, method: string, path: string, session: SignedIn, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: jsonHeaders(base, session, body !== undefined),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const BOUNDARY = 'holydeckE2eBoundary';

// `fetch`'s `BodyInit` wants an `ArrayBufferView<ArrayBuffer>`; a `Buffer` (and a `Uint8Array` built
// from one) is typed against the looser `ArrayBufferLike`, which does not satisfy it — allocating the
// view directly over a plain `ArrayBuffer`, as below, is what keeps its type pinned to what `fetch`
// needs.
const multipartBody = (file: { readonly filename: string; readonly contentType: string; readonly bytes: Uint8Array }): Uint8Array<ArrayBuffer> => {
  const head = Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
  const body = new Uint8Array(new ArrayBuffer(head.length + file.bytes.length + tail.length));
  body.set(head, 0);
  body.set(file.bytes, head.length);
  body.set(tail, head.length + file.bytes.length);
  return body;
};

// A byte layout `sniffMediaType` (packages/contracts/src/media.ts) reads as `video/mp4` (`ftyp` at
// offset 4) with nothing after it a real decoder could parse — enough for `media.ts`'s upload to accept
// it and enqueue a `media-ingest` job, and enough for the worker's real ffmpeg poster step
// (`apps/worker/src/media-ingest.ts`) to fail on it the way a corrupt upload would in production. The
// random tail keeps a repeat local run from colliding with `media.ts`'s own hash-based duplicate check.
const fakeMp4 = (): Uint8Array =>
  new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, ...randomBytes(20)]);

interface JobView {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly state: string;
  readonly lastError?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const parsedJob = (value: unknown): JobView | undefined => {
  if (
    !isRecord(value) ||
    typeof value['id'] !== 'string' ||
    typeof value['idempotencyKey'] !== 'string' ||
    typeof value['state'] !== 'string'
  ) {
    return undefined;
  }
  return {
    id: value['id'],
    idempotencyKey: value['idempotencyKey'],
    state: value['state'],
    lastError: typeof value['lastError'] === 'string' ? value['lastError'] : undefined,
  };
};

const jobsOf = async (base: string, session: SignedIn, kind: string): Promise<readonly JobView[]> => {
  const result = await apiRequest(base, 'GET', `${JOBS_PATH}?kind=${kind}`, session);
  if (result.status !== 200) return [];
  const body = (await result.json()) as { data: { jobs: readonly unknown[] } };
  return body.data.jobs.flatMap((row) => {
    const job = parsedJob(row);
    return job === undefined ? [] : [job];
  });
};

/** Polls `GET /api/v1/jobs?kind=` from the test itself until one row satisfies `match` — Back Up Now has
 *  no completion UI at all (`admin-backups.tsx`'s `backUpNow` only POSTs and reloads the list), and the
 *  Requeue path is the thing under test, so neither can be waited on through the page. */
const pollJobs = async (
  base: string,
  session: SignedIn,
  kind: string,
  match: (job: JobView) => boolean,
  timeoutMs: number,
): Promise<JobView | undefined> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = (await jobsOf(base, session, kind)).find(match);
    if (found !== undefined) return found;
    if (Date.now() > deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
};

test.describe('the v1c-14 admin operations pages', () => {
  test('the new admin pages are reachable, translated, and pass automated accessibility checks', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await claimOrSignIn(page);

    const pages = [
      { path: '/admin/jobs', heading: en('jobs.heading') },
      { path: '/admin/operations', heading: en('operations.heading') },
      { path: '/admin/backups', heading: en('backups.heading') },
      { path: '/account/notifications', heading: en('account.notifications.title') },
    ];

    for (const { path, heading } of pages) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
      const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(audit.violations).toEqual([]);
    }

    await signOutThroughPage(page);
    await page.goto('/admin/jobs');
    await expect(page).toHaveURL(/\/sign-in(?:\?|$)/u);
  });

  test('an administrator requeues a failed job, backs the deployment up, and the service page recaps an ended run', async ({
    baseURL,
    page,
  }, testInfo) => {
    desktopOnly(testInfo);
    test.setTimeout(120_000);
    const base = baseURL as string;

    const controlled = await signInWithControlTo(base);

    // A Service with just enough shown content to leave `readiness()`'s `NOTHING_TO_SHOW` blocker
    // behind (the same minimal shape `live-run.spec.ts` builds), run just long enough to end — nothing
    // here needs the run to stay live, only to have happened, so the service page has an ended run to
    // review and recap below.
    const created = await apiRequest(base, 'POST', SERVICE_PATH, controlled, {
      title: 'Admin operations UI journey',
      date: '2026-09-24',
      site: 'Main Hall',
      sections: [
        { id: 'section-1', name: 'Welcome', items: [{ id: 'item-1', kind: 'custom-slide', title: 'Welcome', enabled: true }] },
      ],
    });
    expect(created.status).toBe(201);
    const serviceId = ((await created.json()) as { data: { stamp: { id: string } } }).data.stamp.id;

    const prepared = await apiRequest(base, 'POST', preparePath(serviceId), controlled, {
      slideLayout: { id: 'layout-1', revision: 1 },
      serviceTemplate: 'template-1@1',
      settings: 'settings@1',
      media: 'media@1',
      corpus: 'corpus@1',
      aspectRatio: '16:9',
    });
    expect(prepared.status).toBe(200);

    const started = await apiRequest(base, 'POST', RUN_PATH, controlled, { serviceId, mode: 'live' });
    expect(started.status).toBe(201);
    const runId = ((await started.json()) as { data: { runId: string } }).data.runId;

    const ended = await apiRequest(base, 'POST', `${RUN_PATH}/${runId}/end`, controlled);
    expect(ended.status).toBe(200);

    const uploadResponse = await fetch(`${base}${MEDIA_PATH}`, {
      method: 'POST',
      headers: {
        origin: base,
        cookie: controlled.cookie,
        [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
        [CSRF_HEADER]: controlled.csrf,
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      },
      body: multipartBody({ filename: 'admin-ops-journey.mp4', contentType: 'video/mp4', bytes: fakeMp4() }),
    });
    expect(uploadResponse.status).toBe(201);
    const assetId = ((await uploadResponse.json()) as { data: { stamp: { id: string } } }).data.stamp.id;

    const failedJob = await pollJobs(
      base,
      controlled,
      'media-ingest',
      (job) => job.idempotencyKey === `media-ingest:${assetId}` && job.state === 'failed',
      30_000,
    );
    expect(failedJob).toBeDefined();
    const jobId = (failedJob as JobView).id;

    // The control grant above persists on the account (`roles.ts`'s `controlPresentation`), so this
    // fresh browser sign-in carries `presentation.control`/`service.read` too — needed for the run
    // review section below. It also leaves `controlled`'s own session alone: only the control-grant PATCH
    // itself revokes every operator session (`accounts-routes.ts`'s `revoked`), a plain sign-in does not.
    await claimOrSignIn(page);

    await page.goto('/admin/jobs');
    await page.getByLabel(en('jobs.filterKindLabel')).fill('media-ingest');
    await page.getByLabel(en('jobs.filterStateLabel')).selectOption('failed');
    const row = page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: jobId, exact: true }) });
    await expect(row).toBeVisible();
    const requeued = page.waitForResponse(
      (response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `${JOBS_PATH}/${jobId}/requeue`,
    );
    await row.getByRole('button', { name: en('jobs.requeue') }).click();
    expect((await requeued).status()).toBe(200);

    await page.goto('/admin/audit');
    await expect(page.getByRole('cell', { name: 'job.requeue', exact: true }).first()).toBeVisible();

    // Back up now (OUI-03): the harness gives both processes a writable restic repository
    // (`tests/harness/src/environment.ts`'s `HOLYDECK_RESTIC_REPOSITORY`), so this is a real backup, not
    // a stub. `POST /api/v1/backups` only enqueues the job (`backup-routes.ts`) and the page never polls
    // it the way it polls a restore, so completion is read back from the queue instead of the page.
    const before = await apiRequest(base, 'GET', BACKUPS_PATH, controlled);
    const beforeCount = ((await before.json()) as { data: { backups: readonly unknown[] } }).data.backups.length;

    await page.goto('/admin/backups');
    const enqueuedBackup = page.waitForResponse(
      (response) => response.request().method() === 'POST' && new URL(response.url()).pathname === BACKUPS_PATH,
    );
    await page.getByRole('button', { name: en('backups.backUpNow') }).click();
    const backupResponse = await enqueuedBackup;
    expect(backupResponse.status()).toBe(202);
    const backupJobId = ((await backupResponse.json()) as { data: { id: string } }).data.id;

    const backupJob = await pollJobs(
      base,
      controlled,
      'backup-run',
      (job) => job.id === backupJobId && (job.state === 'succeeded' || job.state === 'failed'),
      60_000,
    );
    expect(backupJob?.state, backupJob?.lastError ?? `backup-run job ${backupJobId} never reached a terminal state`).toBe('succeeded');

    await page.reload();
    const after = await apiRequest(base, 'GET', BACKUPS_PATH, controlled);
    const afterCount = ((await after.json()) as { data: { backups: readonly unknown[] } }).data.backups.length;
    expect(afterCount).toBe(beforeCount + 1);

    // Run review and recap (OUI-05): mounted on the service's own live page once it has an ended run.
    // The e2e harness's corpus is intentionally empty (the same choice `content.spec.ts` already makes),
    // and `run-review.ts`'s `show` is only ever called from the reference-lookup route
    // (`reference-routes.ts`), which needs a real corpus hit to succeed — so nothing this run did ever
    // reaches the review log, and both sections legitimately render their empty state.
    await page.goto(`/services/${serviceId}/live`);
    await expect(page.getByRole('heading', { name: en('run.section.heading') })).toBeVisible();
    await expect(page.getByRole('heading', { name: en('run.review.heading') })).toBeVisible();
    await expect(page.getByText(en('run.review.empty'))).toBeVisible();
    await expect(page.getByRole('heading', { name: en('run.recap.heading'), exact: true })).toBeVisible();
    await expect(page.locator('#run-recap-format')).toBeVisible();
    await expect(page.getByText(en('run.recap.empty'))).toBeVisible();
  });
});
