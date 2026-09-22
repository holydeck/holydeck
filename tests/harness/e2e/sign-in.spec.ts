// The journey a new installation's people make, entirely through the page: the founder claims it (or,
// on a later browser project, signs in as that founder), creates an Editor from the Users page, signs
// out, and the Editor signs in to a shell that offers no administration and opens a service workspace.
// Every step is a real browser holding the `Secure` session cookie over the stack's HTTPS.

import { AxeBuilder } from '@axe-core/playwright';
import { translate } from '@holydeck/localization/messages';
import { expect, test } from '@playwright/test';

import { claimOrSignIn, signInThroughPage, signOutThroughPage } from './journey.js';

const en = translate.bind(undefined, 'en');

test.describe('signing in through the page', () => {
  test('claims or signs in, creates an Editor, and hands the page over to them', async ({ page }, testInfo) => {
    // One stack serves every project, so each creates its own Editor rather than colliding on one handle.
    const editor = {
      name: `editor-${testInfo.project.name}`,
      displayName: `Editor ${testInfo.project.name}`,
      password: 'another-long-enough-passphrase',
    };

    await claimOrSignIn(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(en('app.services.title'));
    const administration = page.getByRole('navigation', { name: en('app.nav.label') }).getByRole('link', {
      name: en('app.nav.administration'),
    });
    await expect(administration).toBeVisible();

    // The signed-in landing page, graded while the whole shell is up around it.
    const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(audit.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact ?? ''))).toEqual([]);

    await administration.click();
    await expect(page).toHaveURL(/\/admin\/users$/u);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(en('users.title'));
    await expect(page.getByRole('table')).toBeVisible();

    await page.getByLabel(en('users.column.name'), { exact: true }).fill(editor.name);
    await page.getByLabel(en('users.column.displayName'), { exact: true }).fill(editor.displayName);
    await page.getByLabel(en('welcome.password'), { exact: true }).fill(editor.password);
    await page.getByLabel(en('users.column.role'), { exact: true }).selectOption('editor');
    await page.getByRole('button', { name: en('users.create.submit') }).click();
    const row = page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: editor.name, exact: true }) });
    await expect(row).toContainText(en('app.role.editor'));

    await row.getByRole('button', { name: en('users.action.grantControl', { name: editor.displayName }) }).click();
    await expect(row).toContainText(en('users.control.granted'));

    await signOutThroughPage(page);
    await signInThroughPage(page, editor);
    await expect(page.getByRole('button', { name: en('app.signOut') })).toBeVisible();
    // An Editor plans and runs services; accounts and settings are not theirs to reach.
    await expect(page.getByRole('link', { name: en('app.nav.administration') })).toHaveCount(0);

    await page.getByRole('link', { name: en('app.nav.services') }).click();
    await page.goto('/services/harness-service/live');
    await expect(page.locator('#order')).toBeAttached();
    await expect(page.locator('#live-next')).toBeAttached();

    await signOutThroughPage(page);
    // The session really ended: a protected route now sends the page back to signing in.
    await page.goto('/admin/users');
    await expect(page).toHaveURL(/\/sign-in/u);
  });
});
