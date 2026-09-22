// Installed behaviour: what the client is once a device has kept it. A hall with no usable uplink is the
// case this is for, so the parts that make the client installable and keep it working with the network
// gone are graded here rather than assumed from the files being on disk.

import { ONBOARDING_PATH } from '@holydeck/contracts/accounts';
import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { CSRF_HEADER, SESSION_PATH, TICKET_PATH, TICKET_QUERY } from '@holydeck/contracts/sessions';
import { expect, test } from '@playwright/test';

import { OPERATOR } from '../src/identity.js';

import type { Page } from '@playwright/test';

/**
 * What the page has to hold before it may open a socket: a session, and a ticket spent from it. Asked
 * for from inside the page, because the cookie the application sets has to be the cookie the browser
 * sends back on the upgrade — the same journey the client makes, made by the same browser.
 *
 * The claim is allowed to have happened already: three browser projects drive one stack, and the first
 * of them claims it.
 */
const ticketFor = async (page: Page): Promise<string> =>
  page.evaluate(
    async (input: {
      operator: { name: string; displayName: string; password: string };
      version: string;
      versionHeader: string;
      csrfHeader: string;
      onboarding: string;
      session: string;
      ticket: string;
    }) => {
      const post = async (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
        fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [input.versionHeader]: input.version, ...headers },
          body: JSON.stringify(body),
        });
      const claimed = await post(input.onboarding, input.operator);
      if (claimed.status !== 201 && claimed.status !== 404) throw new Error(`the claim answered ${claimed.status}`);
      const opened = await post(input.session, { name: input.operator.name, password: input.operator.password });
      if (opened.status !== 201) throw new Error(`signing in answered ${opened.status}`);
      const session = (await opened.json()) as { data: { csrf: string } };
      const issued = await post(input.ticket, {}, { [input.csrfHeader]: session.data.csrf });
      if (issued.status !== 200) throw new Error(`the ticket answered ${issued.status}`);
      return ((await issued.json()) as { data: { ticket: string } }).data.ticket;
    },
    {
      operator: { ...OPERATOR },
      version: String(CLIENT_WINDOW.current),
      versionHeader: CLIENT_VERSION_HEADER,
      csrfHeader: CSRF_HEADER,
      onboarding: ONBOARDING_PATH,
      session: SESSION_PATH,
      ticket: TICKET_PATH,
    },
  );

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
      // The worker answered the document and its scripts: the mounted client replaced the served
      // fallback with its own main landmark, which only the running script renders.
      await expect(page.locator('main#main')).toBeAttached();
      expect(await page.evaluate(() => navigator.onLine)).toBe(false);
    } finally {
      await context.setOffline(false);
    }
  });

  test('activates a build-specific cache and replaces an older cached shell', async ({ page, context }) => {
    // This same-origin document does not load the client, so no worker activates before the old cache exists.
    await page.goto('/health');
    await page.evaluate(async () => {
      const old = await caches.open('holydeck-web-v1');
      await old.put('/index.html', new Response('<h1>Old cached shell</h1>', { headers: { 'content-type': 'text/html' } }));
      await caches.open('unrelated-cache');
    });

    await page.goto('/');
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
    const names = await page.evaluate(() => caches.keys());
    const current = names.filter((name) => name.startsWith('holydeck-web-'));
    expect(current).toHaveLength(1);
    expect(current[0]).toMatch(/^holydeck-web-[a-z0-9]+$/u);
    expect(current[0]).not.toBe('holydeck-web-dev');
    expect(names).not.toContain('holydeck-web-v1');
    expect(names).toContain('unrelated-cache');

    await context.setOffline(true);
    try {
      await page.goto('/index.html');
      // The worker answered the document and its scripts: the mounted client replaced the served
      // fallback with its own main landmark, which only the running script renders.
      await expect(page.locator('main#main')).toBeAttached();
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
    const ticket = await ticketFor(page);
    const wsUrl =
      `${(baseURL ?? '').replace(/^http/u, 'ws')}/api/v1/live?channel=stage&clientVersion=1&${TICKET_QUERY}=${ticket}`;
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
