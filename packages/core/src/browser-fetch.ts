import { HolyDeckError } from './messages.js';
import type { HttpGet } from './fetcher.js';

/** Subset of puppeteer's API that this module uses, so core needs no type dependency on it. */
export interface BrowserPage {
  setUserAgent: (agent: string) => Promise<void>;
  goto: (url: string, options: { waitUntil: string; timeout: number }) => Promise<unknown>;
  evaluate: <T>(fn: (url: string) => Promise<T>, url: string) => Promise<T>;
}

export interface BrowserSession {
  newPage: () => Promise<BrowserPage>;
  close: () => Promise<void>;
}

export type BrowserLauncher = () => Promise<BrowserSession>;

export interface BrowserHttpGetOptions {
  launch: BrowserLauncher;
  /** Page the session warms up on; its origin is the one later requests are issued from. */
  warmUpUrl?: string;
  userAgent?: string;
  navigationTimeoutMs?: number;
}

const DEFAULT_WARM_UP_URL = 'https://www.bible.com/bible/1/PSA.117.KJV';
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;

/**
 * bible.com fronts its content with a JavaScript bot-protection challenge that a plain HTTP
 * client cannot execute. A real browser runs the challenge once per session; subsequent
 * same-origin `fetch()` calls from inside the page reuse that cleared session, so one warm
 * browser serves an entire sync.
 */
export class BrowserHttpClient {
  private readonly options: Required<Omit<BrowserHttpGetOptions, 'launch'>> & { launch: BrowserLauncher };
  private session?: BrowserSession;
  private page?: BrowserPage;
  private starting?: Promise<BrowserPage>;

  constructor(options: BrowserHttpGetOptions) {
    this.options = {
      launch: options.launch,
      warmUpUrl: options.warmUpUrl ?? DEFAULT_WARM_UP_URL,
      userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
      navigationTimeoutMs: options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
    };
  }

  private async warmPage(): Promise<BrowserPage> {
    if (this.page !== undefined) return this.page;
    this.starting ??= this.start();
    try {
      this.page = await this.starting;
      return this.page;
    } finally {
      this.starting = undefined;
    }
  }

  private async start(): Promise<BrowserPage> {
    let session: BrowserSession;
    try {
      session = await this.options.launch();
    } catch (error) {
      throw new HolyDeckError('browser_unavailable', { reason: (error as Error).message });
    }
    try {
      const page = await session.newPage();
      await page.setUserAgent(this.options.userAgent);
      await page.goto(this.options.warmUpUrl, {
        waitUntil: 'domcontentloaded',
        timeout: this.options.navigationTimeoutMs,
      });
      this.session = session;
      return page;
    } catch (error) {
      await session.close().catch(() => undefined);
      throw new HolyDeckError('browser_unavailable', { reason: (error as Error).message });
    }
  }

  /** Drop-in replacement for the plain-HTTP `HttpGet` the Fetcher takes. */
  readonly httpGet: HttpGet = async (url) => {
    const page = await this.warmPage();
    return page.evaluate(
      async (target) => {
        const response = await fetch(target, { headers: { accept: 'text/html,application/json;q=0.9,*/*;q=0.8' } });
        return { status: response.status, body: await response.text() };
      },
      url,
    );
  };

  async close(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    this.page = undefined;
    if (session !== undefined) await session.close();
  }
}
