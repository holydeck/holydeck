// Installed behaviour: what the client is once a device has kept it. A hall with no usable uplink is the
// case this is for, so the parts that make the client installable and keep it working with the network
// gone are graded here rather than assumed from the files being on disk.

import { expect, test } from '@playwright/test';

test.describe('the client a device can install and keep', () => {
  test('offers a manifest a browser will install from', async ({ page, baseURL }) => {
    await page.goto('/');
    const href = await page.locator('link[rel=manifest]').getAttribute('href');
    expect(href).toBe('/manifest.webmanifest');
    const response = await page.request.get(new URL(href ?? '', baseURL).href);
    expect(response.status()).toBe(200);
    // Served as a manifest, not as text a browser will ignore.
    expect(response.headers()['content-type']).toContain('manifest+json');
    const manifest = (await response.json()) as {
      name: string;
      start_url: string;
      display: string;
      icons: Array<{ sizes: string }>;
    };
    expect(manifest).toMatchObject({ name: 'HolyDeck', start_url: '/', display: 'standalone' });
    expect(manifest.icons.map((icon) => icon.sizes).sort()).toEqual(['192x192', '512x512']);
  });

  test('registers a service worker and lets it take control', async ({ page }) => {
    await page.goto('/');
    const state = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      const worker = registration.active;
      if (worker === null) return 'no worker at all';
      // `ready` resolves as soon as there is an active worker, which can still be running its activate
      // handler — and this client's handler drops the caches of earlier builds in it.
      if (worker.state !== 'activated') {
        await new Promise<void>((resolve) => {
          worker.addEventListener('statechange', () => {
            if (worker.state === 'activated') resolve();
          });
        });
      }
      return worker.state;
    });
    expect(state).toBe('activated');
    // A controller only exists once the worker is running the page, which is what makes the next test
    // possible at all: a reload with no network is answered by the worker, not by the server.
    await page.reload();
    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  });

  test('still opens with the network gone', async ({ page, context }) => {
    await page.goto('/');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await context.setOffline(true);
    try {
      await page.reload();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('HolyDeck');
      expect(await page.evaluate(() => navigator.onLine)).toBe(false);
    } finally {
      await context.setOffline(false);
    }
  });

  test('opens the live socket the page is allowed to open', async ({ page, baseURL }) => {
    const violations: string[] = [];
    page.on('console', (message) => {
      if (message.text().includes('Content Security Policy')) violations.push(message.text());
    });
    await page.goto('/');
    const wsUrl = `${(baseURL ?? '').replace(/^http/u, 'ws')}/api/v1/live?channel=stage&clientVersion=1`;
    const frame = await page.evaluate(
      (url) =>
        new Promise<unknown>((resolve, reject) => {
          const socket = new WebSocket(url);
          socket.addEventListener('message', (event: MessageEvent) => {
            socket.close();
            resolve(JSON.parse(String(event.data)));
          });
          socket.addEventListener('error', () => reject(new Error('the page could not open the socket')));
          socket.addEventListener('close', (event: CloseEvent) => {
            if (event.code !== 1000) reject(new Error(`the socket closed with ${event.code}: ${event.reason}`));
          });
        }),
      wsUrl,
    );
    expect(frame).toMatchObject({ kind: 'snapshot', channel: 'stage' });
    // The same-origin policy the client is served under has to permit its own socket, or the presenter
    // view is dead on a device whose console nobody is watching.
    expect(violations).toEqual([]);
  });
});
