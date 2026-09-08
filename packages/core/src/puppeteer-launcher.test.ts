import { describe, expect, it, vi } from 'vitest';
import { createPuppeteerLauncher } from './puppeteer-launcher.js';

const launch = vi.fn().mockResolvedValue({ newPage: vi.fn(), close: vi.fn() });
vi.mock('puppeteer', () => ({ launch: (config: Record<string, unknown>) => launch(config) }));

// puppeteer would otherwise install signal handlers that exit the process, skipping our cleanup.
const OWN_SIGNALS = { handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false };

describe('createPuppeteerLauncher', () => {
  it('launches headless, and keeps signal handling for the caller, by default', async () => {
    launch.mockClear();
    await createPuppeteerLauncher()();
    expect(launch).toHaveBeenCalledWith({ headless: true, ...OWN_SIGNALS });
  });

  it('passes through the executable path, args and headless flag', async () => {
    launch.mockClear();
    await createPuppeteerLauncher({
      executablePath: '/usr/bin/chromium',
      args: ['--no-sandbox'],
      headless: false,
    })();
    expect(launch).toHaveBeenCalledWith({
      headless: false,
      executablePath: '/usr/bin/chromium',
      args: ['--no-sandbox'],
      ...OWN_SIGNALS,
    });
  });
});

describe('createPuppeteerLauncher without puppeteer installed', () => {
  it('reports browser_unavailable when the import fails', async () => {
    vi.resetModules();
    vi.doMock('puppeteer', () => {
      throw new Error('Cannot find package');
    });
    const { createPuppeteerLauncher: create } = await import('./puppeteer-launcher.js');
    await expect(create()()).rejects.toMatchObject({
      code: 'browser_unavailable',
      params: { reason: expect.stringContaining('puppeteer is not installed') as unknown as string },
    });
    vi.doUnmock('puppeteer');
    vi.resetModules();
  });
});
