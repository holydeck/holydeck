// The shell graded against WCAG rather than eyeballed: a contrast ratio or a missing label is the kind
// of regression that never throws and never fails a layout assertion, so nothing above this file would
// ever catch one.

import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.describe('the shell against automated accessibility rules', () => {
  test('serves a page with no detectable WCAG 2.1 AA violation', async ({ page }) => {
    await page.goto('/');
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });
});
