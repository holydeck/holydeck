// Signing in the way a person does: through the page, over the HTTPS the stack serves, so the session
// the rest of a spec runs under is the `Secure` cookie the browser itself kept. Three browser projects
// drive one stack, so whichever arrives first claims the instance through the welcome form and every
// later one finds it claimed and signs in instead; both paths end signed in as the same operator.

import { translate } from '@holydeck/localization/messages';
import { expect } from '@playwright/test';

import { OPERATOR } from '../src/identity.js';

import type { Page } from '@playwright/test';

const en = (key: Parameters<typeof translate>[1]): string => translate('en', key);

/** Where a fresh page lands once `boot()` has learned whether the instance is claimed and who is in. */
const LANDING = /\/(?:welcome|sign-in)(?:\?|$)/u;

/** Fills the sign-in form and waits for the services page the client moves a new session to. */
export async function signInThroughPage(page: Page, account: { readonly name: string; readonly password: string }): Promise<void> {
  if (!/\/sign-in(?:\?|$)/u.test(page.url())) await page.goto('/sign-in');
  await page.getByLabel(en('signIn.name')).fill(account.name);
  await page.getByLabel(en('signIn.password'), { exact: true }).fill(account.password);
  await page.getByRole('button', { name: en('signIn.submit') }).click();
  await expect(page).toHaveURL(/\/services$/u);
}

/** Claims the instance through the welcome form when it is still offered, and reports whether it was. */
export async function claimOrSignIn(page: Page): Promise<'claimed' | 'signed-in'> {
  await page.goto('/');
  await expect(page).toHaveURL(LANDING);
  if (!new URL(page.url()).pathname.startsWith('/welcome')) {
    await signInThroughPage(page, OPERATOR);
    return 'signed-in';
  }
  await page.getByLabel(en('welcome.name')).fill(OPERATOR.name);
  await page.getByLabel(en('welcome.displayName')).fill(OPERATOR.displayName);
  await page.getByLabel(en('welcome.password'), { exact: true }).fill(OPERATOR.password);
  await page.getByLabel(en('welcome.confirm')).fill(OPERATOR.password);
  await page.getByRole('button', { name: en('welcome.submit') }).click();
  await expect(page).toHaveURL(/\/services$/u);
  return 'claimed';
}

/** Ends the session from the shell's own button and waits for the sign-in page it leaves the page on. */
export async function signOutThroughPage(page: Page): Promise<void> {
  await page.getByRole('button', { name: en('app.signOut') }).click();
  await expect(page).toHaveURL(/\/sign-in$/u);
}
