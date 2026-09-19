import { describe, expect, it, vi } from 'vitest';

import { LOCALES } from '@holydeck/localization/locales';
import { translate } from '@holydeck/localization/messages';

import { detectScreens, launchOutputSurface, presentSurfaceLaunch } from './output-launch.js';

import type { DetectedScreen, SurfaceLaunchControls } from './output-launch.js';

// Real-device coverage for the two-output DisplayLink configuration this module unblocks lives in T7's
// `hardware/index.json`: seven of its eight DisplayLink protocol steps are recorded `blocked`, naming
// this task as what they were waiting on, and DISC-03 stays open until the maintainer supplies a
// MacBook Air M1 or a Windows 11 machine and the inventoried DisplayLink adapter to run them on
// (`evidence/2026-09-12-hardware-evidence.md`). Nothing below fabricates or skips that run; this suite
// proves the launch and fallback mechanics those steps will exercise once the hardware exists.

const screenAt = (overrides: Partial<DetectedScreen> = {}): DetectedScreen => ({
  left: 0,
  top: 0,
  width: 1920,
  height: 1080,
  isPrimary: false,
  ...overrides,
});

const notAllowed = (): Error => {
  const error = new Error('permission refused');
  error.name = 'NotAllowedError';
  return error;
};

describe('detecting screens through the Window Management API', () => {
  it('reads an absent API as unavailable, not an error', async () => {
    await expect(detectScreens({})).resolves.toEqual({ kind: 'unavailable', reason: 'api-absent' });
  });

  it('reports every screen the API enumerates', async () => {
    const window = {
      getScreenDetails: async () => ({
        screens: [
          { availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1040, isPrimary: true },
          { availLeft: 1920, availTop: 0, availWidth: 1280, availHeight: 1024 },
        ],
      }),
    };
    await expect(detectScreens(window)).resolves.toEqual({
      kind: 'detected',
      screens: [
        { left: 0, top: 0, width: 1920, height: 1040, isPrimary: true },
        { left: 1920, top: 0, width: 1280, height: 1024, isPrimary: false },
      ],
    });
  });

  it('reads a denied or unanswered permission as unavailable, the same as an absent API', async () => {
    const window = {
      getScreenDetails: async () => {
        throw notAllowed();
      },
    };
    await expect(detectScreens(window)).resolves.toEqual({ kind: 'unavailable', reason: 'permission-denied' });
  });
});

describe('launching an output surface', () => {
  it('opens Audience, Stage and Singer independently — one blocked never blocks the others', () => {
    const open = vi.fn((_url: string, target: string) => (target === 'holydeck-output-stage' ? null : {}));

    const audience = launchOutputSurface({ open }, 'audience', '/live/audience', screenAt());
    const stage = launchOutputSurface({ open }, 'stage', '/live/stage', screenAt({ left: 1920 }));
    const singer = launchOutputSurface({ open }, 'singer', '/live/singer', screenAt());

    expect(audience).toEqual({ kind: 'launched', view: 'audience', placement: 'screen' });
    expect(stage).toEqual({ kind: 'blocked', view: 'stage' });
    expect(singer).toEqual({ kind: 'launched', view: 'singer', placement: 'screen' });
    expect(open).toHaveBeenCalledWith('/live/audience', 'holydeck-output-audience', 'left=0,top=0,width=1920,height=1080');
    expect(open).toHaveBeenCalledWith('/live/stage', 'holydeck-output-stage', 'left=1920,top=0,width=1920,height=1080');
  });

  it('falls back to a plain, unplaced window when no screen was detected — and the fallback still opens', () => {
    const open = vi.fn(() => ({}));
    const launch = launchOutputSurface({ open }, 'audience', '/live/audience');

    expect(launch).toEqual({ kind: 'launched', view: 'audience', placement: 'manual' });
    expect(open).toHaveBeenCalledWith('/live/audience', 'holydeck-output-audience', undefined);
  });

  it('reads window.open returning null as blocked', () => {
    const launch = launchOutputSurface({ open: () => null }, 'singer', '/live/singer');
    expect(launch).toEqual({ kind: 'blocked', view: 'singer' });
  });

  it('reads window.open throwing as blocked too, not as an unhandled failure', () => {
    const open = (): never => {
      throw new Error('SecurityError');
    };
    const launch = launchOutputSurface({ open }, 'stage', '/live/stage');
    expect(launch).toEqual({ kind: 'blocked', view: 'stage' });
  });
});

describe('the manual fallback when the placement API is unavailable', () => {
  it('still launches the surface and says so, end to end from detection through the DOM', async () => {
    const detection = await detectScreens({});
    expect(detection.kind).toBe('unavailable');

    const open = vi.fn(() => ({}));
    const launch = launchOutputSurface({ open }, 'stage', '/live/stage');

    const status = { textContent: null as string | null };
    const retry = { hidden: true, onclick: null as (() => void) | null };
    presentSurfaceLaunch({ status, retry }, launch, () => undefined, 'en');

    expect(status.textContent).toContain('Drag this window onto its screen');
    expect(retry.hidden).toBe(true);
  });
});

describe('presenting a successful placement on a detected screen', () => {
  it.each(LOCALES)('says, in %s, the surface opened on its assigned screen and hides the retry affordance', (locale) => {
    const controls: SurfaceLaunchControls = { status: { textContent: null }, retry: { hidden: false, onclick: null } };

    presentSurfaceLaunch(controls, { kind: 'launched', view: 'singer', placement: 'screen' }, () => undefined, locale);

    expect(controls.status.textContent).toBe(
      translate(locale, 'output.launch.screen', { view: translate(locale, 'output.channel.singer') }),
    );
    expect(controls.retry.hidden).toBe(true);
  });
});

describe('presenting a blocked launch as a recoverable, operator-actioned state', () => {
  const controlsOf = (): SurfaceLaunchControls => ({
    status: { textContent: null },
    retry: { hidden: true, onclick: null },
  });

  it.each(LOCALES)('shows the block visibly in %s and offers a click that retries the launch', (locale) => {
    const controls = controlsOf();
    const retry = vi.fn();

    presentSurfaceLaunch(controls, { kind: 'blocked', view: 'audience' }, retry, locale);

    expect(controls.status.textContent).toBe(
      translate(locale, 'output.launch.blocked', { view: translate(locale, 'output.channel.audience') }),
    );
    expect(controls.retry.hidden).toBe(false);
    expect(retry).not.toHaveBeenCalled();

    controls.retry.onclick?.();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('recovers: a launch after the retry hides the affordance again', () => {
    const controls = controlsOf();
    presentSurfaceLaunch(controls, { kind: 'blocked', view: 'audience' }, () => undefined, 'en');
    expect(controls.retry.hidden).toBe(false);

    presentSurfaceLaunch(controls, { kind: 'launched', view: 'audience', placement: 'manual' }, () => undefined, 'en');

    expect(controls.retry.hidden).toBe(true);
    expect(controls.retry.onclick).toBeNull();
    expect(controls.status.textContent).toContain('opened');
  });

  it('replaces rather than stacks the retry handler on a repeated presentation', () => {
    const controls = controlsOf();
    const firstRetry = vi.fn();
    const secondRetry = vi.fn();

    presentSurfaceLaunch(controls, { kind: 'blocked', view: 'singer' }, firstRetry, 'en');
    presentSurfaceLaunch(controls, { kind: 'blocked', view: 'singer' }, secondRetry, 'en');

    controls.retry.onclick?.();
    expect(firstRetry).not.toHaveBeenCalled();
    expect(secondRetry).toHaveBeenCalledTimes(1);
  });
});

describe('presenting the manual-placement fallback across locales', () => {
  it.each(LOCALES)('gives the drag instruction in %s for a surface opened without a screen', (locale) => {
    const controls = { status: { textContent: null as string | null }, retry: { hidden: false, onclick: null } };

    presentSurfaceLaunch(controls, { kind: 'launched', view: 'stage', placement: 'manual' }, () => undefined, locale);

    expect(controls.status.textContent).toBe(
      translate(locale, 'output.launch.manual', { view: translate(locale, 'output.channel.stage') }),
    );
    expect(controls.retry.hidden).toBe(true);
  });
});
