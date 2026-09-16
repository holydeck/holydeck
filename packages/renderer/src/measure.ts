// Text measurement, done by a real layout engine instead of a table of font metrics.
//
// This is the load-bearing decision behind REND-01's "one deterministic renderer". Every surface that
// ever draws a slide — the editor's live preview, a thumbnail job, an output view, the offline presenter
// — has to agree to the pixel about how tall a line of a given font at a given size in a given box is.
// Two hand-rolled metric approximations in two surfaces would disagree eventually, and the disagreement
// would show up as a line of a song that wraps in the preview and not on the wall. So measurement happens
// once, in headless Chrome, against the frozen reference canvas, and the answer is recorded into the
// prepared model. Surfaces never measure; they replay what preparation measured. The offline presenter
// works precisely because it has no browser to disagree with.
//
// puppeteer is an optional peer dependency, imported lazily, the same way `@holydeck/core` treats it: an
// install that only ever replays prepared models never pays for a Chromium download.

export interface MeasureRequest {
  readonly text: string;
  readonly fontFamily: string;
  readonly fontWeight: number;
  readonly fontSizePx: number;
  /** Unitless multiple of the font size, the way CSS `line-height: 1.2` is. */
  readonly lineHeight: number;
  readonly letterSpacingPx: number;
  readonly maxWidthPx: number;
}

export interface TextMetrics {
  /** The widest line, not the box: a short line in a wide box measures short. */
  readonly widthPx: number;
  readonly heightPx: number;
  readonly lineCount: number;
}

export interface TextMeasurer {
  measure: (requests: readonly MeasureRequest[]) => Promise<readonly TextMetrics[]>;
  close: () => Promise<void>;
}

export class MeasurementUnavailableError extends Error {
  constructor(reason: string) {
    super(`text measurement is unavailable: ${reason}`);
    this.name = 'MeasurementUnavailableError';
  }
}

/**
 * Answers come back matched to requests by position and by nothing else, so a batch that returned a
 * different number of them would hand one box the size measured for another — a wrong font size on a wall,
 * arrived at silently. There is no recovery from that, only a refusal.
 */
export class MeasurementMismatchError extends Error {
  constructor(requested: number, measured: number) {
    super(`text measurement sent ${requested} requests and got ${measured} measurements back`);
    this.name = 'MeasurementMismatchError';
  }
}

export interface MeasurementPage {
  setViewport: (viewport: { width: number; height: number; deviceScaleFactor: number }) => Promise<unknown>;
  setContent: (html: string) => Promise<unknown>;
  evaluate: <A, R>(fn: (argument: A) => R, argument: A) => Promise<Awaited<R>>;
}

export interface MeasurementSession {
  newPage: () => Promise<MeasurementPage>;
  close: () => Promise<void>;
}

export type MeasurementLauncher = () => Promise<MeasurementSession>;

// The slice of the DOM the in-page function touches. Declaring it here rather than pulling in the whole
// `dom` lib keeps this package's tsconfig the same as every other one in the repository, and keeps the
// measured surface small enough that a test can stand a document in for it.
interface MeasurementRect {
  readonly width: number;
  readonly height: number;
  readonly top: number;
}

interface MeasurementNode {
  readonly style: Record<string, string>;
  textContent: string;
  getBoundingClientRect: () => MeasurementRect;
}

interface MeasurementRange {
  selectNodeContents: (node: MeasurementNode) => void;
  getClientRects: () => ArrayLike<MeasurementRect>;
}

interface MeasurementDocument {
  createElement: (tag: string) => MeasurementNode;
  createRange: () => MeasurementRange;
  readonly body: { appendChild: (node: MeasurementNode) => unknown; removeChild: (node: MeasurementNode) => unknown };
  readonly fonts?: { readonly ready: Promise<unknown> };
}

declare const document: MeasurementDocument;

/** The page the measurements happen on: no margins, no inherited type, nothing that could shift a line. */
export const MEASUREMENT_DOCUMENT =
  '<!doctype html><html><head><meta charset="utf-8"><style>' +
  'html,body{margin:0;padding:0;border:0;font-kerning:normal;text-rendering:geometricPrecision}' +
  '</style></head><body></body></html>';

export const REFERENCE_VIEWPORT = Object.freeze({ width: 1920, height: 1080, deviceScaleFactor: 1 });

/** Subpixel noise below this is not a layout decision; rounding it keeps a re-preparation byte-stable. */
export const MEASUREMENT_PRECISION = 2;

const rounded = (value: number): number => Number(value.toFixed(MEASUREMENT_PRECISION));

/**
 * Runs inside the page, once per preparation, for every candidate size of every text box at once. It is
 * serialized across the wire by puppeteer, so it closes over nothing and calls nothing defined outside
 * itself.
 */
const measureInPage = (batch: readonly MeasureRequest[]): TextMetrics[] =>
  batch.map((request) => {
    const node = document.createElement('div');
    node.style.position = 'absolute';
    node.style.left = '-20000px';
    node.style.top = '0';
    node.style.visibility = 'hidden';
    node.style.width = `${request.maxWidthPx}px`;
    node.style.whiteSpace = 'normal';
    node.style.overflowWrap = 'break-word';
    node.style.fontFamily = request.fontFamily;
    node.style.fontWeight = String(request.fontWeight);
    node.style.fontSize = `${request.fontSizePx}px`;
    node.style.lineHeight = String(request.lineHeight);
    node.style.letterSpacing = `${request.letterSpacingPx}px`;
    node.textContent = request.text;
    document.body.appendChild(node);

    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = range.getClientRects();
    const tops: number[] = [];
    let widest = 0;
    for (let index = 0; index < rects.length; index += 1) {
      const rect = rects[index];
      if (rect === undefined) continue;
      widest = Math.max(widest, rect.width);
      const top = Math.round(rect.top * 100) / 100;
      if (!tops.includes(top)) tops.push(top);
    }
    const heightPx = node.getBoundingClientRect().height;
    document.body.removeChild(node);

    return { widthPx: widest, heightPx, lineCount: Math.max(tops.length, 1) };
  });

export interface PuppeteerLaunchOptions {
  /** Chromium executable to drive; defaults to the browser puppeteer downloaded. */
  readonly executablePath?: string;
  /** Extra flags — containers generally need --no-sandbox. */
  readonly args?: readonly string[];
  readonly headless?: boolean;
}

/**
 * Deliberately a near-copy of `@holydeck/core`'s `createPuppeteerLauncher` rather than an import of it,
 * and not for weight: that module pulls in nothing at runtime but its own error messages, and puppeteer is
 * externalized by tsup in both packages. The reason is the page. Core's `BrowserPage` is shaped for its
 * scraper — `setUserAgent`, `goto`, an `evaluate` typed around a URL — and a `MeasurementPage` needs
 * `setViewport`, `setContent` and a generic `evaluate`. Importing core's launcher would mean either
 * widening a scraper-facing contract to carry a presentation-rendering concern, tying two domains that
 * have no reason to move together, or casting the session to a shape it does not have.
 *
 * The tripwire: if a third package ever needs this launch logic, that is when it gets extracted to a
 * shared home. Two is not enough to extract for.
 */
export function createPuppeteerMeasurementLauncher(options: PuppeteerLaunchOptions = {}): MeasurementLauncher {
  return async (): Promise<MeasurementSession> => {
    let puppeteer: { launch: (config: Record<string, unknown>) => Promise<MeasurementSession> };
    try {
      puppeteer = (await import('puppeteer')) as unknown as typeof puppeteer;
    } catch (error) {
      throw new MeasurementUnavailableError(`puppeteer is not installed (${(error as Error).message})`);
    }
    // puppeteer's own signal handlers kill the browser and call process.exit, which would strand a
    // half-prepared model. The caller shuts the browser down instead.
    const config: Record<string, unknown> = {
      headless: options.headless ?? true,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    };
    if (options.executablePath !== undefined) config.executablePath = options.executablePath;
    if (options.args !== undefined) config.args = [...options.args];
    return puppeteer.launch(config);
  };
}

export interface BrowserTextMeasurerOptions extends PuppeteerLaunchOptions {
  /** Injected by the suites, and by any caller that already has a browser open. */
  readonly launch?: MeasurementLauncher;
  /** Extra CSS the measurement page loads first — `@font-face` rules, when a font pipeline exists. */
  readonly styleSheet?: string;
}

export function createBrowserTextMeasurer(options: BrowserTextMeasurerOptions = {}): TextMeasurer {
  const launch = options.launch ?? createPuppeteerMeasurementLauncher(options);
  let session: MeasurementSession | undefined;
  let opening: Promise<MeasurementPage> | undefined;
  let page: MeasurementPage | undefined;

  const open = async (): Promise<MeasurementPage> => {
    const opened = await launch();
    session = opened;
    const fresh = await opened.newPage();
    await fresh.setViewport({ ...REFERENCE_VIEWPORT });
    const sheet = options.styleSheet === undefined ? '' : `<style>${options.styleSheet}</style>`;
    await fresh.setContent(MEASUREMENT_DOCUMENT.replace('</head>', `${sheet}</head>`));
    // A font that is still loading measures as its fallback, which is a different set of glyphs and a
    // different answer. Chrome resolves this promise once every face the page asked for has settled.
    await fresh.evaluate(async () => {
      await document.fonts?.ready;
    }, undefined);
    return fresh;
  };

  const ready = async (): Promise<MeasurementPage> => {
    if (page !== undefined) return page;
    opening ??= open();
    try {
      page = await opening;
      return page;
    } finally {
      opening = undefined;
    }
  };

  return {
    measure: async (requests: readonly MeasureRequest[]): Promise<readonly TextMetrics[]> => {
      if (requests.length === 0) return [];
      const metrics = await (await ready()).evaluate(measureInPage, requests);
      if (metrics.length !== requests.length) throw new MeasurementMismatchError(requests.length, metrics.length);
      return metrics.map((entry) => ({
        widthPx: rounded(entry.widthPx),
        heightPx: rounded(entry.heightPx),
        lineCount: entry.lineCount,
      }));
    },
    close: async (): Promise<void> => {
      const running = session;
      session = undefined;
      page = undefined;
      if (running !== undefined) await running.close();
    },
  };
}
