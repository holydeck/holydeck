import { describe, expect, it, vi } from 'vitest';

import { registerServiceWorker } from './register-service-worker.js';

describe('registering the service worker', () => {
  it('registers the worker at the scope of the whole client', async () => {
    const register = vi.fn(async () => ({}));

    await expect(registerServiceWorker({ register }, '/service-worker.js')).resolves.toBe(true);
    expect(register).toHaveBeenCalledWith('/service-worker.js', { scope: '/' });
  });

  it('says so and carries on where service workers are unavailable', async () => {
    await expect(registerServiceWorker(undefined, '/service-worker.js')).resolves.toBe(false);
  });

  it('swallows a refusal when the caller asked to be told nothing', async () => {
    const register = vi.fn(async () => {
      throw new Error('refused');
    });

    await expect(registerServiceWorker({ register }, '/service-worker.js')).resolves.toBe(false);
  });

  it('does not break the client when registration is refused', async () => {
    const register = vi.fn(async () => {
      throw new Error('refused');
    });
    const onError = vi.fn();

    await expect(
      registerServiceWorker({ register }, '/service-worker.js', onError),
    ).resolves.toBe(false);
    expect(onError).toHaveBeenCalledWith(new Error('refused'));
  });
});
