// What a device gets when it opens HolyDeck: the shell, in its own language, laid out for its own
// screen, taking the kind of input that screen has. Every assertion here is made through a real browser
// against the real stack, on each of the three form factors the project promises to serve.

import { expect, test } from '@playwright/test';

import { GERMAN_SIGN_IN, GERMAN_WELCOME, PREPARING_STATUS } from './copy.js';

test.describe('the shell a device opens', () => {
  test('serves a readable page before any script has run', async ({ browser }) => {
    // JavaScript off is the worst case a projector-room laptop can be in, and it still has to say
    // something true rather than show an empty dark rectangle. The served document is all it gets.
    const context = await browser.newContext({ javaScriptEnabled: false, ignoreHTTPSErrors: true });
    try {
      const page = await context.newPage();
      const response = await page.goto('/');
      expect(response?.status()).toBe(200);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('HolyDeck');
      await expect(page.locator('#status')).toHaveText(PREPARING_STATUS);
    } finally {
      await context.close();
    }
  });

  test('replaces the served English with the language the device asked for', async ({ browser }) => {
    const context = await browser.newContext({ locale: 'de-CH', ignoreHTTPSErrors: true });
    try {
      const page = await context.newPage();
      await page.goto('/');
      // Claimed or not, a device with no session lands on a form headed in its own language.
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(new RegExp(`^(?:${GERMAN_SIGN_IN}|${GERMAN_WELCOME})$`, 'u'));
      // What a screen reader announces the document in, which is the reason the client sets it first.
      await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    } finally {
      await context.close();
    }
  });

  test('lays the shell out inside the screen it was opened on', async ({ page }) => {
    await page.goto('/');
    const layout = await page.evaluate(() => {
      const main = document.querySelector('main');
      return {
        viewport: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        // The content box: the 40rem cap is on the text column, and the padding sits outside it.
        mainWidth: main === null ? 0 : Number.parseFloat(getComputedStyle(main).width),
        fontSize: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      };
    });
    // Nothing sideways to scroll: a presenter on a phone should never have to pan to read a line.
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewport);
    // Below the desktop breakpoint the reading column is capped rather than stretched; at and above
    // 1200px, ui-contract.md's three-panel workspace (264/480min/336, 32px gutter, 16px gaps) needs the
    // full width, so the cap lifts there instead.
    if (layout.viewport < 1200) {
      const cap = 40 * layout.fontSize;
      expect(layout.mainWidth).toBeLessThanOrEqual(Math.min(layout.viewport, cap) + 1);
    } else {
      expect(layout.mainWidth).toBeLessThanOrEqual(layout.viewport + 1);
    }
  });

  test('takes the kind of input the screen it is on has', async ({ page }, testInfo) => {
    await page.goto('/');
    // The client moves `/` on to a form once it knows whether anybody is signed in; tapping before that
    // would grade a heading the next render replaces.
    await expect(page).toHaveURL(/\/(?:welcome|sign-in)(?:\?|$)/u);
    const pointers = await page.evaluate(() => {
      const seen: string[] = [];
      document.addEventListener('pointerdown', (event) => seen.push(event.pointerType));
      Object.assign(window, { holydeckPointers: seen });
      return { coarse: matchMedia('(pointer: coarse)').matches, touchPoints: navigator.maxTouchPoints };
    });
    const touchScreen = testInfo.project.name !== 'desktop';
    expect(pointers.coarse).toBe(touchScreen);
    expect(pointers.touchPoints > 0).toBe(touchScreen);

    const heading = page.getByRole('heading', { level: 1 });
    if (touchScreen) await heading.tap();
    else await heading.click();
    // The input reached the page, and reached it as the kind of input the device actually has: a tablet
    // that arrives as a mouse is a tablet whose long-press and drag gestures will never fire.
    expect(await page.evaluate(() => (window as unknown as { holydeckPointers: string[] }).holydeckPointers)).toEqual([
      touchScreen ? 'touch' : 'mouse',
    ]);
  });

  test('takes keys from an operator who never touches the screen', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      const seen: string[] = [];
      document.addEventListener('keydown', (event) => seen.push(event.key));
      Object.assign(window, { holydeckKeys: seen });
    });
    // The four a presenter uses without looking down, and the one that gets out of a full-screen output.
    for (const key of ['ArrowRight', 'ArrowLeft', 'Space', 'Escape', 'Tab']) await page.keyboard.press(key);
    expect(await page.evaluate(() => (window as unknown as { holydeckKeys: string[] }).holydeckKeys)).toEqual([
      'ArrowRight',
      'ArrowLeft',
      ' ',
      'Escape',
      'Tab',
    ]);
  });
});
