import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { openExternalUrl, startLoopbackCallback } from './oidc-node.js';

function fakeSpawn(event: 'spawn' | 'error') {
  const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
  child.unref = vi.fn();
  const spawn = vi.fn(() => {
    queueMicrotask(() => child.emit(event, event === 'error' ? new Error('missing') : undefined));
    return child;
  });
  return { child, spawn };
}

describe('openExternalUrl', () => {
  it.each([
    ['darwin', 'open', ['https://example.com']],
    ['linux', 'xdg-open', ['https://example.com']],
    ['win32', 'rundll32.exe', ['url.dll,FileProtocolHandler', 'https://example.com']],
  ] as const)('uses the platform browser command on %s', async (platform, command, args) => {
    const fake = fakeSpawn('spawn');
    await expect(openExternalUrl('https://example.com', platform, fake.spawn as never)).resolves.toBe(true);
    expect(fake.spawn).toHaveBeenCalledWith(command, args, { detached: true, stdio: 'ignore' });
    expect(fake.child.unref).toHaveBeenCalledOnce();
  });

  it('returns false when no browser command can be started', async () => {
    const fake = fakeSpawn('error');
    await expect(openExternalUrl('https://example.com', 'linux', fake.spawn as never)).resolves.toBe(false);
    expect(fake.child.unref).not.toHaveBeenCalled();
  });
});

describe('startLoopbackCallback', () => {
  it('accepts an Authelia form_post callback', async () => {
    const callback = await startLoopbackCallback(0, 'expected');
    const response = await fetch(callback.redirectUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ state: 'expected', code: 'authorization-code' }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Authentication complete');
    await expect(callback.code).resolves.toBe('authorization-code');
    await callback.close();
  });

  it('also accepts a query callback after rejecting unrelated and malformed requests', async () => {
    const callback = await startLoopbackCallback(0, 'expected');
    expect((await fetch(callback.redirectUri.replace('/callback', '/other'))).status).toBe(404);
    expect((await fetch(callback.redirectUri, { method: 'PUT' })).status).toBe(404);
    expect((await fetch(`${callback.redirectUri}?state=wrong&code=x`)).status).toBe(400);
    expect((await fetch(`${callback.redirectUri}?state=expected`)).status).toBe(400);
    expect((await fetch(`${callback.redirectUri}?state=expected&code=`)).status).toBe(400);
    expect((await fetch(`${callback.redirectUri}?state=expected&code=query-code`)).status).toBe(200);
    await expect(callback.code).resolves.toBe('query-code');
    await callback.close();
  });

  it.each([
    ['', 'access_denied'],
    ['&error_description=User+cancelled', 'access_denied: User cancelled'],
  ])('rejects an OAuth callback error (%s)', async (description, expected) => {
    const callback = await startLoopbackCallback(0, 'expected');
    const response = await fetch(`${callback.redirectUri}?state=expected&error=access_denied${description}`);
    expect(response.status).toBe(400);
    await expect(callback.code).rejects.toThrow(expected);
    await callback.close();
  });

  it('times out and can be closed before a callback', async () => {
    const timedOut = await startLoopbackCallback(0, 'expected', 5);
    await expect(timedOut.code).rejects.toThrow('timed out');
    await timedOut.close();

    const closed = await startLoopbackCallback(0, 'expected');
    await closed.close();
    await expect(closed.code).rejects.toThrow('listener closed');
  });

  it('drops an oversized callback body', async () => {
    const callback = await startLoopbackCallback(0, 'expected');
    await expect(
      fetch(callback.redirectUri, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `state=expected&code=${'x'.repeat(16_384)}`,
      }),
    ).rejects.toThrow();
    await callback.close();
    await expect(callback.code).rejects.toThrow('listener closed');
  });

  it('rejects when the requested port is already in use', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const port = (blocker.address() as AddressInfo).port;
    try {
      await expect(startLoopbackCallback(port, 'expected')).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
