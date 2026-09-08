import { HolyDeckError } from './messages.js';
import type { BrowserLauncher, BrowserSession } from './browser-fetch.js';

export interface PuppeteerLauncherOptions {
  /** Chromium executable to drive; defaults to the browser puppeteer downloaded. */
  executablePath?: string;
  /** Extra flags — containers generally need --no-sandbox. */
  args?: string[];
  headless?: boolean;
}

/**
 * Loads puppeteer lazily so it stays an optional dependency: installs that never sync
 * (server-mode CLIs, for instance) do not pay for a Chromium download.
 */
export function createPuppeteerLauncher(options: PuppeteerLauncherOptions = {}): BrowserLauncher {
  return async (): Promise<BrowserSession> => {
    let puppeteer: { launch: (config: Record<string, unknown>) => Promise<BrowserSession> };
    try {
      puppeteer = (await import('puppeteer')) as unknown as typeof puppeteer;
    } catch (error) {
      throw new HolyDeckError('browser_unavailable', {
        reason: `puppeteer is not installed (${(error as Error).message})`,
      });
    }
    // puppeteer's own signal handlers kill the browser and call process.exit, which would skip
    // the datastore save and lock release. The caller shuts the browser down instead.
    const config: Record<string, unknown> = {
      headless: options.headless ?? true,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    };
    if (options.executablePath !== undefined) config.executablePath = options.executablePath;
    if (options.args !== undefined) config.args = options.args;
    return puppeteer.launch(config);
  };
}
