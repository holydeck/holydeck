// The service workspace journey WS-14 describes, driven through the page the way an operator uses it:
// create a service, build its order from the Add panel, reorder, disable, remove and undo, preview a
// slide, set the service's own output ratio, and come back to where they left off from the dashboard.
// Every screen it passes through is graded against WCAG 2.1 AA on the way. The harness corpus and song
// catalogue start empty, so the order is built from blank slides; Bible and Song inserts are proved by
// their own component tests and by content.spec.ts's API journey.

import { AxeBuilder } from '@axe-core/playwright';
import { translate } from '@holydeck/localization/messages';
import { expect, test } from '@playwright/test';

import { claimOrSignIn } from './journey.js';

import type { Page } from '@playwright/test';

const en = (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]): string => translate('en', key, values);

/** Grades the page as it now stands against the WCAG 2.1 AA rules `accessibility.spec.ts` uses. */
const checkA11y = async (page: Page): Promise<void> => {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`)).toEqual([]);
};

const TITLE = 'Workspace Journey';

const orderRows = (page: Page) => page.locator('.order-item');

const insertBlank = async (page: Page): Promise<void> => {
  const count = await orderRows(page).count();
  await page.getByRole('tablist', { name: en('workspace.region.details') }).getByRole('tab', { name: en('workspace.tab.library') }).click();
  await page.getByRole('tab', { name: en('add.tab.blank') }).click();
  await page.getByRole('button', { name: en('blank.insert') }).click();
  await expect(orderRows(page)).toHaveCount(count + 1);
};

test.describe('the service workspace', () => {
  test('builds, edits and resumes a service from the dashboard', async ({ page }, testInfo) => {
    // One shared stack for the run: the service this creates would collide with itself on a second pass.
    test.skip(testInfo.project.name !== 'desktop', 'one shared stack; this journey runs once, not per form factor');
    test.setTimeout(120_000);

    await claimOrSignIn(page);
    await expect(page.getByRole('heading', { level: 1, name: en('dashboard.title') })).toBeVisible();
    await checkA11y(page);

    await page.getByRole('link', { name: en('dashboard.new') }).click();
    await expect(page.getByRole('heading', { level: 1, name: en('serviceNew.title') })).toBeVisible();
    await checkA11y(page);
    await page.getByLabel(en('serviceNew.source.blank')).check();
    await page.getByLabel(en('serviceNew.date')).fill('2099-01-04');
    await page.getByLabel(en('serviceNew.titleField')).fill(TITLE);
    await page.getByLabel(en('serviceNew.site')).fill('Main Hall');
    await page.getByRole('button', { name: en('serviceNew.create') }).click();
    await expect(page).toHaveURL(/\/services\/[^/]+$/u);

    // With nothing selected, Properties holds the service's own output profile: 4:3 overrides the default.
    await page.getByRole('radio', { name: '4:3' }).check();
    await expect(page.getByText(`${en('output.ratio', { ratio: '4:3' })} ${en('output.source.service')}`)).toBeVisible();

    // A blank service has no section yet; every Add tab inserts into one.
    await page.getByRole('navigation', { name: en('workspace.region.order') }).getByRole('button', { name: en('order.section.add') }).click();
    await expect(page.getByRole('button', { name: en('order.section.add') })).toHaveCount(0);
    await insertBlank(page);
    await insertBlank(page);
    await checkA11y(page);

    // Move the second slide up: the order changes only once the server has answered.
    const second = orderRows(page).nth(1);
    const secondId = await second.getAttribute('data-item-id');
    await second.getByRole('button', { name: en('order.actions', { title: en('blank.title') }) }).click();
    await page.getByRole('menuitem', { name: en('order.moveUp') }).click();
    await expect(orderRows(page).first()).toHaveAttribute('data-item-id', secondId!);

    const first = orderRows(page).first();
    await first.getByRole('button', { name: en('order.actions', { title: en('blank.title') }) }).click();
    await page.getByRole('menuitem', { name: en('order.disable') }).click();
    await expect(first.getByText(en('order.disabled'), { exact: true })).toBeVisible();
    await first.getByRole('button', { name: en('order.actions', { title: en('blank.title') }) }).click();
    await page.getByRole('menuitem', { name: en('order.enable') }).click();
    await expect(first.getByText(en('order.disabled'), { exact: true })).toHaveCount(0);

    await first.getByRole('button', { name: en('order.actions', { title: en('blank.title') }) }).click();
    await page.getByRole('menuitem', { name: en('order.remove') }).click();
    await expect(orderRows(page)).toHaveCount(1);
    await page.getByRole('button', { name: en('order.undo') }).click();
    await expect(orderRows(page)).toHaveCount(2);
    await expect(orderRows(page).first()).toHaveAttribute('data-item-id', secondId!);

    // Expanding a slide draws its thumbnail; the selected slide's exact preview carries the safe-area legend.
    await orderRows(page).first().getByRole('button', { name: en('order.expand', { title: en('blank.title') }) }).click();
    await expect(orderRows(page).first().getByRole('img').first()).toBeVisible();
    await expect(page.getByText(en('preview.safeArea')).first()).toBeVisible();

    // Give the position writer time to record the selection before leaving.
    await page.waitForTimeout(2_500);
    const workspace = page.url();
    await page.goto('/services');
    await expect(page.getByRole('heading', { name: en('dashboard.continue.heading') })).toBeVisible();
    await page.getByRole('link', { name: en('dashboard.continue.open', { title: TITLE }) }).click();
    await expect(page).toHaveURL(new RegExp(`^${workspace.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'));

    await page.goto('/library');
    await expect(page.getByRole('heading', { level: 1, name: en('library.title') })).toBeVisible();
    await checkA11y(page);

    await page.goto('/media');
    await expect(page.getByRole('heading', { level: 1, name: en('media.title') })).toBeVisible();
    await expect(page.getByRole('heading', { name: en('mediaLib.upload') })).toBeVisible();
    await checkA11y(page);
  });
});
