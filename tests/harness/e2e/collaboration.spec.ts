// The three browser journeys spec 09's Test Plan names, each driven through the pages a person uses:
// two people saving the same song at once and settling the loser from the shelf, then restoring an old
// revision from the history page; an account setting up an authenticator app and signing back in with a
// code from it; and an administrator changing a retention setting that the audit viewer then shows.
//
// Setup the journeys only lean on — the song both people open, the account that enrols — is made over the
// API with the operator's session, the same way content.spec.ts does, so what the browser drives is the
// collaboration itself and not the forms other specs already walk through.
//
// The authenticator codes are computed here from the secret the page shows, exactly as an app would (RFC
// 6238: HMAC-SHA1, 30 s steps, six digits). The server accepts each step once, so signing in afterwards
// uses the next step's code, which its one-step drift window still takes.

import { createHmac } from 'node:crypto';

import { ACCOUNTS_PATH } from '@holydeck/contracts/accounts';
import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { CSRF_HEADER } from '@holydeck/contracts/sessions';
import { SONGS_PATH } from '@holydeck/contracts/songs';
import { translate } from '@holydeck/localization/messages';
import { expect, test } from '@playwright/test';

import { OPERATOR, signInTo } from '../src/identity.js';
import { signInThroughPage, signOutThroughPage } from './journey.js';

import type { SignedIn } from '../src/identity.js';
import type { Page, Response as PageResponse, TestInfo } from '@playwright/test';

const en = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]): string =>
  translate('en', key, params);

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

const secretBytes = (secret: string): Buffer => {
  const bytes: number[] = [];
  let value = 0;
  let bits = 0;
  for (const symbol of secret.replace(/=+$/u, '')) {
    value = ((value << 5) | BASE32.indexOf(symbol)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
};

/** The six digits an authenticator shows for `secret` at `step` (RFC 4226 dynamic truncation). */
const codeAt = (secret: string, step: number): string => {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', secretBytes(secret)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
};

const currentStep = (): number => Math.floor(Date.now() / 1000 / STEP_SECONDS);

const request = async (baseUrl: string, method: string, path: string, session: SignedIn, body?: unknown): Promise<Response> =>
  fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      origin: baseUrl,
      [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
      cookie: session.cookie,
      [CSRF_HEADER]: session.csrf,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** Resolves with the next save of `songId` the page sends, once its answer is in. */
const songSave = (page: Page, songId: string): Promise<PageResponse> =>
  page.waitForResponse((response) =>
    response.request().method() === 'PUT' && new URL(response.url()).pathname === `${SONGS_PATH}/${songId}`);

// One shared stack for the whole run (globalSetup, workers: 1): the song, the enrolled account and the
// changed setting would each meet their own first pass on a second form factor.
const desktopOnly = (testInfo: TestInfo): void => {
  test.skip(testInfo.project.name !== 'desktop', 'one shared stack; these journeys run once, not per form factor');
};

test.describe('spec 09 collaboration and account administration', () => {
  test('a second save of the same song is shelved, kept, and an old revision restored', async ({ baseURL, browser, page }, testInfo) => {
    desktopOnly(testInfo);
    const url = baseURL!;
    const admin = await signInTo(url);
    const created = await request(url, 'POST', SONGS_PATH, admin, {
      title: 'Shelf journey',
      body: {
        titles: { tamil: 'அலமாரி', romanized: 'Alamaari' },
        languages: ['ta'],
        sections: [{ id: 'verse-1', label: 'Verse 1', text: [{ languageKey: 'ta', text: 'வரிகள்' }] }],
        provenance: { source: 'manual' },
      },
    });
    expect(created.status).toBe(201);
    const songId = ((await created.json()) as { data: { stamp: { id: string } } }).data.stamp.id;

    const other = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const second = await other.newPage();
      for (const person of [page, second]) {
        await signInThroughPage(person, OPERATOR);
        await person.goto(`/library?open=${encodeURIComponent(songId)}`);
        await expect(person.getByLabel(en('song.titleTamil'))).toHaveValue('அலமாரி');
      }

      // The first person saves against revision 1 and wins.
      const won = songSave(page, songId);
      await page.getByLabel(en('song.titleTamil')).fill('அலமாரி ஒன்று');
      expect((await won).status()).toBe(200);

      // The second person still holds revision 1, so their save is refused and shelved.
      const lost = songSave(second, songId);
      await second.getByLabel(en('song.titleTamil')).fill('அலமாரி இரண்டு');
      expect((await lost).status()).toBe(409);
      await expect(second.getByText(en('song.stale'))).toBeVisible();
      const keepMine = second.getByRole('button', { name: en('conflicts.keepMine') });
      await expect(keepMine).toBeVisible();

      await keepMine.click();
      await expect(keepMine).toHaveCount(0);

      // Every save above is a revision; restoring the first one adds one more rather than rewriting any.
      await second.goto(`/content/${encodeURIComponent(songId)}/history`);
      const revisions = second.getByRole('listitem').filter({ hasText: /Revision \d+ —/u });
      await expect(revisions.first()).toBeVisible();
      const before = await revisions.count();
      await revisions.filter({ hasText: /Revision 1 —/u }).getByRole('button', { name: en('history.restore') }).click();
      await second.getByRole('alertdialog').getByRole('button', { name: en('history.confirm') }).click();
      await expect(revisions).toHaveCount(before + 1);
    } finally {
      await other.close();
    }
  });

  test('an account sets up an authenticator app and signs in again with its code', async ({ baseURL, page }, testInfo) => {
    desktopOnly(testInfo);
    const url = baseURL!;
    const admin = await signInTo(url);
    const account = { name: `totp-journey-${Date.now().toString(36)}`, password: 'a-long-enough-passphrase-too' };
    const created = await request(url, 'POST', ACCOUNTS_PATH, admin, { ...account, displayName: 'TOTP Journey', role: 'editor' });
    expect(created.status).toBe(201);

    await signInThroughPage(page, account);
    await page.goto('/account/security');
    await page.getByRole('button', { name: en('security.totp.setup') }).click();
    const secret = (await page.locator('code').first().textContent())?.trim() ?? '';
    expect(secret).toMatch(/^[A-Z2-7]+$/u);

    await page.getByRole('textbox', { name: en('security.totp.codeLabel'), exact: true }).fill(codeAt(secret, currentStep()));
    await page.getByRole('button', { name: en('security.totp.verify') }).click();
    await expect(page.getByText(en('security.totp.enrolledStatus'))).toBeVisible();

    await signOutThroughPage(page);
    await page.getByLabel(en('signIn.name')).fill(account.name);
    await page.getByLabel(en('signIn.password'), { exact: true }).fill(account.password);
    await page.getByLabel(en('signIn.code')).fill(codeAt(secret, currentStep() + 1));
    await page.getByRole('button', { name: en('signIn.submit') }).click();
    await expect(page).toHaveURL(/\/services$/u);
  });

  test('an administrator changes audit retention and the audit viewer shows the change', async ({ baseURL, page }, testInfo) => {
    desktopOnly(testInfo);
    await signInTo(baseURL!);
    await signInThroughPage(page, OPERATOR);
    await page.goto('/admin/settings');
    const retention = page.getByLabel(en('settings.field.auditRetentionDays'));
    await expect(retention).toHaveValue(/\d/u);
    await retention.fill('400');
    await page.getByRole('button', { name: en('settings.save') }).click();
    await expect(page.locator('#announce-polite')).toHaveText(en('settings.saved'));

    await page.goto('/admin/audit');
    await expect(page.getByRole('cell', { name: 'settings.update', exact: true }).first()).toBeVisible();
  });
});
