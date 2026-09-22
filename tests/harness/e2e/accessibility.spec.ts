// The shell graded against WCAG rather than eyeballed: a contrast ratio or a missing label is the kind
// of regression that never throws and never fails a layout assertion, so nothing above this file would
// ever catch one.

import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.describe('the shell against automated accessibility rules', () => {
  test('serves a signed-out page with no detectable WCAG 2.1 AA violation', async ({ page }) => {
    await page.goto('/');
    // Graded once the client has put its form up, not the moment between the served fallback and it.
    await expect(page).toHaveURL(/\/(?:welcome|sign-in)(?:\?|$)/u);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });
});
