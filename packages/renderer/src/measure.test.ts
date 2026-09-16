import { describe, expect, it, vi } from 'vitest';

import { fakePage, fakeSession, layoutDocument, withDocument } from '../test/helpers/page.js';
import {
  MEASUREMENT_DOCUMENT,
  MeasurementMismatchError,
  REFERENCE_VIEWPORT,
  createBrowserTextMeasurer,
  createPuppeteerMeasurementLauncher,
} from './measure.js';

import type { FakeRect } from '../test/helpers/page.js';
import type { MeasureRequest } from './measure.js';

const request = (overrides: Partial<MeasureRequest> = {}): MeasureRequest => ({
  text: 'Praise to the Lord the Almighty',
  fontFamily: 'Inter',
  fontWeight: 600,
  fontSizePx: 40,
  lineHeight: 1.2,
  letterSpacingPx: 0,
  maxWidthPx: 400,
  ...overrides,
});

describe('measuring in a real document', () => {
  it('opens one page, sets the reference viewport, and measures every request on it', async () => {
    const page = fakePage();
    const session = fakeSession(page);
    const measurer = createBrowserTextMeasurer({ launch: () => Promise.resolve(session) });
    const document = layoutDocument();

    const metrics = await withDocument(document, async () =>
      measurer.measure([request(), request({ fontSizePx: 20 })]),
    );

    expect(session.pages).toBe(1);
    expect(page.viewports).toEqual([{ ...REFERENCE_VIEWPORT }]);
    expect(page.contents[0]).toBe(MEASUREMENT_DOCUMENT);
    expect(metrics).toHaveLength(2);
    expect(metrics[0]?.lineCount).toBeGreaterThan(metrics[1]?.lineCount ?? 0);
    expect(document.tags).toEqual(['div', 'div']);
    expect(document.attached).toEqual([]);
  });

  it('reuses the page it already opened', async () => {
    const session = fakeSession();
    const measurer = createBrowserTextMeasurer({ launch: () => Promise.resolve(session) });

    await withDocument(layoutDocument(), async () => {
      await Promise.all([measurer.measure([request()]), measurer.measure([request()])]);
      await measurer.measure([request()]);
    });

    expect(session.pages).toBe(1);
  });

  it('waits for the page fonts before measuring a fallback face by accident', async () => {
    let settled = false;
    const fonts = { ready: Promise.resolve().then(() => (settled = true)) };
    const measurer = createBrowserTextMeasurer({ launch: () => Promise.resolve(fakeSession()) });

    await withDocument(layoutDocument(fonts), async () => measurer.measure([request()]));

    expect(settled).toBe(true);
  });

  it('injects a caller stylesheet ahead of the measurement page', async () => {
    const page = fakePage();
    const measurer = createBrowserTextMeasurer({
      launch: () => Promise.resolve(fakeSession(page)),
      styleSheet: '@font-face{font-family:Inter;src:local("Inter")}',
    });

    await withDocument(layoutDocument(), async () => measurer.measure([request()]));

    expect(page.contents[0]).toContain('@font-face{font-family:Inter');
    expect(page.contents[0]).toContain('</head>');
  });

  it('rounds subpixel noise away so a re-measurement is the same number', async () => {
    const noisy = {
      ...layoutDocument(),
      createElement: () => ({
        style: {} as Record<string, string>,
        textContent: '',
        getBoundingClientRect: (): FakeRect => ({ width: 10, height: 48.123_456, top: 0 }),
      }),
      createRange: () => ({
        selectNodeContents: () => undefined,
        getClientRects: (): ArrayLike<FakeRect> => [{ width: 199.987_654, height: 24, top: 0 }],
      }),
    };

    const measurer = createBrowserTextMeasurer({ launch: () => Promise.resolve(fakeSession()) });
    const [metrics] = await withDocument(noisy, async () => measurer.measure([request()]));

    expect(metrics).toEqual({ widthPx: 199.99, heightPx: 48.12, lineCount: 1 });
  });

  it('counts one line per distinct rect top, and never fewer than one', async () => {
    const split = {
      ...layoutDocument(),
      createRange: () => ({
        selectNodeContents: () => undefined,
        // Two rects sharing a top are one line split at a style boundary, not two lines — and the hole
        // at index two is a sparse rect list, which is not a reason to stop measuring.
        getClientRects: (): ArrayLike<FakeRect> => ({
          length: 3,
          0: { width: 100, height: 24, top: 0 },
          1: { width: 60, height: 24, top: 0 },
        }),
      }),
    };
    const empty = {
      ...layoutDocument(),
      createRange: () => ({ selectNodeContents: () => undefined, getClientRects: (): ArrayLike<FakeRect> => [] }),
    };
    const measurer = createBrowserTextMeasurer({ launch: () => Promise.resolve(fakeSession()) });

    const [joined] = await withDocument(split, async () => measurer.measure([request()]));
    const [blank] = await withDocument(empty, async () => measurer.measure([request({ text: '' })]));

    expect(joined?.lineCount).toBe(1);
    expect(joined?.widthPx).toBe(100);
    expect(blank?.lineCount).toBe(1);
  });

  // Answers are matched to requests by position and nothing else, so a batch that came back a different
  // length would silently hand box two the size that was measured for box three. That is a wrong slide on
  // a wall, and it has to be an error rather than a smaller number.
  it('refuses a batch of answers that does not line up with the requests it sent', async () => {
    // A page that answers every request but the first: the same shape a batch dropped in transit has.
    const short = {
      ...fakePage(),
      evaluate: <A, R>(fn: (argument: A) => R, argument: A): Promise<Awaited<R>> =>
        Promise.resolve(
          (Array.isArray(argument) ? argument.slice(1) : []).map(() => ({
            widthPx: 10,
            heightPx: 10,
            lineCount: 1,
          })) as unknown as Awaited<R>,
        ),
    };
    const measurer = createBrowserTextMeasurer({ launch: () => Promise.resolve(fakeSession(short)) });

    await expect(measurer.measure([request(), request({ fontSizePx: 20 })])).rejects.toBeInstanceOf(
      MeasurementMismatchError,
    );
    await expect(measurer.measure([request(), request({ fontSizePx: 20 })])).rejects.toThrow(
      /2 requests.*1 measurement/u,
    );
  });

  it('asks for no browser at all when there is nothing to measure', async () => {
    const launch = vi.fn();
    const measurer = createBrowserTextMeasurer({ launch });

    expect(await measurer.measure([])).toEqual([]);
    expect(launch).not.toHaveBeenCalled();
  });

  it('closes the session it opened, and opens a fresh one if asked again', async () => {
    const first = fakeSession();
    const second = fakeSession();
    const sessions = [first, second];
    const measurer = createBrowserTextMeasurer({ launch: () => Promise.resolve(sessions.shift() ?? first) });

    await withDocument(layoutDocument(), async () => {
      await measurer.measure([request()]);
      await measurer.close();
      await measurer.measure([request()]);
    });
    await measurer.close();

    expect(first.closes).toBe(1);
    expect(second.pages).toBe(1);
    expect(second.closes).toBe(1);
  });

  it('closes nothing when it never opened anything', async () => {
    await expect(createBrowserTextMeasurer({ launch: vi.fn() }).close()).resolves.toBeUndefined();
  });
});

const launch = vi.fn().mockResolvedValue({ newPage: vi.fn(), close: vi.fn() });
vi.mock('puppeteer', () => ({ launch: (config: Record<string, unknown>) => launch(config) }));

// puppeteer would otherwise install signal handlers that exit the process, stranding a half-prepared model.
const OWN_SIGNALS = { handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false };

describe('the puppeteer measurement launcher', () => {
  it('launches headless and leaves signal handling to the caller', async () => {
    launch.mockClear();
    await createPuppeteerMeasurementLauncher()();
    expect(launch).toHaveBeenCalledWith({ headless: true, ...OWN_SIGNALS });
  });

  it('passes the executable path, args and headless flag through', async () => {
    launch.mockClear();
    await createPuppeteerMeasurementLauncher({
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

describe('a measurer with no launcher handed to it', () => {
  it('opens puppeteer itself', async () => {
    const session = fakeSession();
    launch.mockClear();
    launch.mockResolvedValueOnce(session);

    const metrics = await withDocument(layoutDocument(), async () =>
      createBrowserTextMeasurer({ args: ['--no-sandbox'] }).measure([request()]),
    );

    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ args: ['--no-sandbox'] }));
    expect(metrics).toHaveLength(1);
  });
});

describe('the puppeteer measurement launcher without puppeteer installed', () => {
  it('says measurement is unavailable rather than failing as a missing module', async () => {
    vi.resetModules();
    vi.doMock('puppeteer', () => {
      throw new Error('Cannot find package');
    });
    const { createPuppeteerMeasurementLauncher: create } = await import('./measure.js');

    await expect(create()()).rejects.toMatchObject({
      name: 'MeasurementUnavailableError',
      message: expect.stringContaining('puppeteer is not installed') as unknown as string,
    });

    vi.doUnmock('puppeteer');
    vi.resetModules();
  });
});
