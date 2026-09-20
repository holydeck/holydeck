import { describe, expect, it, vi } from 'vitest';

import { LOCALES } from '@holydeck/localization/locales';
import { translate } from '@holydeck/localization/messages';

import {
  createWakeLockController,
  enterFullscreen,
  leaveFullscreen,
  presentFullscreenState,
  presentWakeLockState,
  watchFullscreenChange,
  wireLocalOutputKeyboard,
} from './local-output.js';

import type {
  FullscreenDocumentLike,
  FullscreenState,
  KeyboardTargetLike,
  LocalOutputStatusLike,
  VisibilityDocumentLike,
  WakeLockNavigatorLike,
  WakeLockSentinelLike,
  WakeLockState,
} from './local-output.js';

// Real-device coverage for the single-screen presentation path this module unblocks lives in the same
// T7 evidence `output-launch.ts` cites: `hardware/index.json` records the DisplayLink protocol steps as
// `blocked`, and DISC-03 stays open until the maintainer supplies the hardware to run them on
// (`evidence/2026-09-12-hardware-evidence.md`). Nothing below fabricates or skips that run; this suite
// proves the fullscreen, keyboard, and wake-lock mechanics those steps will exercise once it exists.

const deniedError = (): Error => {
  const error = new Error('permission refused');
  error.name = 'NotAllowedError';
  return error;
};

describe('entering fullscreen', () => {
  it('reads an absent API as unavailable, not an error', async () => {
    await expect(enterFullscreen({})).resolves.toEqual({ kind: 'unavailable', reason: 'api-absent' });
  });

  it('reports entered once requestFullscreen resolves', async () => {
    const element = { requestFullscreen: vi.fn(async () => undefined) };
    await expect(enterFullscreen(element)).resolves.toEqual({ kind: 'entered' });
    expect(element.requestFullscreen).toHaveBeenCalledTimes(1);
  });

  it('reads a denied or unanswered prompt as unavailable, the same as an absent API', async () => {
    const element = {
      requestFullscreen: async () => {
        throw deniedError();
      },
    };
    await expect(enterFullscreen(element)).resolves.toEqual({ kind: 'unavailable', reason: 'denied' });
  });
});

describe('leaving fullscreen', () => {
  it('does nothing when the document is not in fullscreen', async () => {
    const exitFullscreen = vi.fn(async () => undefined);
    await leaveFullscreen({ fullscreenElement: null, exitFullscreen });
    expect(exitFullscreen).not.toHaveBeenCalled();
  });

  it('does nothing when the document has no exitFullscreen method', async () => {
    await expect(leaveFullscreen({ fullscreenElement: {} })).resolves.toBeUndefined();
  });

  it('exits when the document is in fullscreen', async () => {
    const exitFullscreen = vi.fn(async () => undefined);
    await leaveFullscreen({ fullscreenElement: {}, exitFullscreen });
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it('swallows a refused exit rather than throwing', async () => {
    const exitFullscreen = async (): Promise<void> => {
      throw new Error('refused');
    };
    await expect(leaveFullscreen({ fullscreenElement: {}, exitFullscreen })).resolves.toBeUndefined();
  });
});

describe('watching fullscreen transitions', () => {
  const fakeDocument = (): FullscreenDocumentLike & {
    fire: () => void;
    fullscreenElement: object | null;
  } => {
    let listener: (() => void) | undefined;
    return {
      fullscreenElement: null,
      addEventListener: (_type, handler) => {
        listener = handler;
      },
      removeEventListener: (_type, handler) => {
        if (listener === handler) listener = undefined;
      },
      fire() {
        listener?.();
      },
    };
  };

  it('reports entered and exited as the underlying element changes, including a change this module never requested', () => {
    const document = fakeDocument();
    const states: FullscreenState[] = [];
    watchFullscreenChange(document, (state) => states.push(state));

    document.fullscreenElement = {};
    document.fire();
    document.fullscreenElement = null;
    document.fire();

    expect(states).toEqual([{ kind: 'entered' }, { kind: 'exited' }]);
  });

  it('stops reporting once unsubscribed', () => {
    const document = fakeDocument();
    const onChange = vi.fn();
    const unsubscribe = watchFullscreenChange(document, onChange);

    unsubscribe();
    document.fullscreenElement = {};
    document.fire();

    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('presenting fullscreen state', () => {
  const statusOf = (): LocalOutputStatusLike => ({ textContent: null });

  it.each(LOCALES)('says fullscreen is active in %s', (locale) => {
    const status = statusOf();
    presentFullscreenState(status, { kind: 'entered' }, locale);
    expect(status.textContent).toBe(translate(locale, 'localOutput.fullscreen.entered'));
  });

  it.each(LOCALES)('says fullscreen ended in %s', (locale) => {
    const status = statusOf();
    presentFullscreenState(status, { kind: 'exited' }, locale);
    expect(status.textContent).toBe(translate(locale, 'localOutput.fullscreen.exited'));
  });

  it('names the same manual fallback for an absent API as for a denied prompt', () => {
    const status = statusOf();
    presentFullscreenState(status, { kind: 'unavailable', reason: 'api-absent' }, 'en');
    expect(status.textContent).toContain('F11');

    presentFullscreenState(status, { kind: 'unavailable', reason: 'denied' }, 'en');
    expect(status.textContent).toContain('F11');
  });
});

describe('wiring local-output keyboard navigation', () => {
  const fakeTarget = (): KeyboardTargetLike & {
    press: (key: string) => void;
    lastPreventDefault: () => ReturnType<typeof vi.fn<() => void>> | undefined;
  } => {
    let listener: ((event: { readonly key: string; preventDefault(): void }) => void) | undefined;
    let lastPreventDefault: ReturnType<typeof vi.fn<() => void>> | undefined;
    return {
      addEventListener: (_type, handler) => {
        listener = handler;
      },
      removeEventListener: (_type, handler) => {
        if (listener === handler) listener = undefined;
      },
      press(key: string) {
        lastPreventDefault = vi.fn<() => void>();
        listener?.({ key, preventDefault: lastPreventDefault });
      },
      lastPreventDefault: () => lastPreventDefault,
    };
  };

  it('moves forward on the arrow, space and paging-forward keys', () => {
    const target = fakeTarget();
    const next = vi.fn();
    const previous = vi.fn();
    wireLocalOutputKeyboard(target, { next, previous });

    for (const key of ['ArrowRight', 'ArrowDown', ' ', 'PageDown']) target.press(key);

    expect(next).toHaveBeenCalledTimes(4);
    expect(previous).not.toHaveBeenCalled();
  });

  it('moves back on the arrow, backspace and paging-back keys', () => {
    const target = fakeTarget();
    const next = vi.fn();
    const previous = vi.fn();
    wireLocalOutputKeyboard(target, { next, previous });

    for (const key of ['ArrowLeft', 'ArrowUp', 'Backspace', 'PageUp']) target.press(key);

    expect(previous).toHaveBeenCalledTimes(4);
    expect(next).not.toHaveBeenCalled();
  });

  it('ignores every other key, including Escape — the browser handles that one by itself', () => {
    const target = fakeTarget();
    const next = vi.fn();
    const previous = vi.fn();
    wireLocalOutputKeyboard(target, { next, previous });

    for (const key of ['Escape', 'Enter', 'a', 'F11']) target.press(key);

    expect(next).not.toHaveBeenCalled();
    expect(previous).not.toHaveBeenCalled();
  });

  it('prevents the browser default for a key it acts on, so Backspace cannot navigate away from a live presentation', () => {
    const target = fakeTarget();
    wireLocalOutputKeyboard(target, { next: vi.fn(), previous: vi.fn() });

    target.press('Backspace');

    expect(target.lastPreventDefault()).toHaveBeenCalledTimes(1);
  });

  it('leaves native browser behavior untouched for a key it does not act on', () => {
    const target = fakeTarget();
    wireLocalOutputKeyboard(target, { next: vi.fn(), previous: vi.fn() });

    for (const key of ['Escape', 'Enter', 'a', 'F11']) {
      target.press(key);
      expect(target.lastPreventDefault()).not.toHaveBeenCalled();
    }
  });

  it('stops navigating once unsubscribed', () => {
    const target = fakeTarget();
    const next = vi.fn();
    const unsubscribe = wireLocalOutputKeyboard(target, { next, previous: vi.fn() });

    unsubscribe();
    target.press('ArrowRight');

    expect(next).not.toHaveBeenCalled();
  });
});

describe('fullscreen entry feeding straight into keyboard navigation, end to end', () => {
  it('enters fullscreen from a gesture and then reads the keys that gesture unlocked', async () => {
    const element = { requestFullscreen: vi.fn(async () => undefined) };
    const entry = await enterFullscreen(element);
    expect(entry).toEqual({ kind: 'entered' });

    const target: KeyboardTargetLike & { press: (key: string) => void } = (() => {
      let listener: ((event: { readonly key: string; preventDefault(): void }) => void) | undefined;
      return {
        addEventListener: (_type, handler) => {
          listener = handler;
        },
        removeEventListener: () => {
          listener = undefined;
        },
        press(key: string) {
          listener?.({ key, preventDefault: () => undefined });
        },
      };
    })();
    const next = vi.fn();
    wireLocalOutputKeyboard(target, { next, previous: vi.fn() });
    target.press(' ');

    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('holding a screen wake lock', () => {
  const fakeSentinel = (): WakeLockSentinelLike & { fireRelease: () => void } => {
    let listener: (() => void) | undefined;
    let released = false;
    return {
      get released() {
        return released;
      },
      release: vi.fn(async () => {
        released = true;
      }),
      addEventListener: (_type, handler) => {
        listener = handler;
      },
      fireRelease() {
        listener?.();
      },
    };
  };

  const fakeDocument = (): VisibilityDocumentLike & {
    setVisibility: (state: 'visible' | 'hidden') => void;
  } => {
    let listener: (() => void) | undefined;
    let visibilityState: 'visible' | 'hidden' = 'visible';
    return {
      get visibilityState() {
        return visibilityState;
      },
      addEventListener: (_type, handler) => {
        listener = handler;
      },
      removeEventListener: (_type, handler) => {
        if (listener === handler) listener = undefined;
      },
      setVisibility(state) {
        visibilityState = state;
        listener?.();
      },
    };
  };

  it('reports unavailable, not an error, when the API is absent', async () => {
    const document = fakeDocument();
    const states: WakeLockState[] = [];
    const controller = createWakeLockController({}, document, (state) => states.push(state));

    await controller.request();

    expect(states).toEqual([{ kind: 'unavailable', reason: 'api-absent' }]);
  });

  it('reports unavailable when the request is refused', async () => {
    const document = fakeDocument();
    const navigator: WakeLockNavigatorLike = {
      wakeLock: {
        request: async () => {
          throw deniedError();
        },
      },
    };
    const states: WakeLockState[] = [];
    const controller = createWakeLockController(navigator, document, (state) => states.push(state));

    await controller.request();

    expect(states).toEqual([{ kind: 'unavailable', reason: 'denied' }]);
  });

  it('reports active once acquired, and the controller reads the same current state', async () => {
    const document = fakeDocument();
    const sentinel = fakeSentinel();
    const navigator: WakeLockNavigatorLike = { wakeLock: { request: vi.fn(async () => sentinel) } };
    const controller = createWakeLockController(navigator, document, () => undefined);

    await controller.request();

    expect(controller.state).toEqual({ kind: 'active' });
  });

  it('reports loss visibly — never silently — when the browser releases the lock on its own', async () => {
    const document = fakeDocument();
    const sentinel = fakeSentinel();
    const navigator: WakeLockNavigatorLike = { wakeLock: { request: async () => sentinel } };
    const states: WakeLockState[] = [];
    const controller = createWakeLockController(navigator, document, (state) => states.push(state));

    await controller.request();
    sentinel.fireRelease();

    expect(states).toEqual([{ kind: 'active' }, { kind: 'lost' }]);
    expect(controller.state).toEqual({ kind: 'lost' });
  });

  it('reacquires after a visibility change — asserting the second request, not just the first', async () => {
    const document = fakeDocument();
    const first = fakeSentinel();
    const second = fakeSentinel();
    const request = vi.fn(async () => (request.mock.calls.length === 1 ? first : second));
    const navigator: WakeLockNavigatorLike = { wakeLock: { request } };
    const states: WakeLockState[] = [];
    const controller = createWakeLockController(navigator, document, (state) => states.push(state));

    await controller.request();
    document.setVisibility('hidden');
    first.fireRelease();
    document.setVisibility('visible');
    // The reacquire triggered by the visibility change is fire-and-forget; wait for it to settle
    // rather than assuming any fixed number of microtask ticks.
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));

    expect(states.at(-1)).toEqual({ kind: 'active' });
  });

  it('does not reacquire on a visibility change while still hidden', async () => {
    const document = fakeDocument();
    const sentinel = fakeSentinel();
    const request = vi.fn(async () => sentinel);
    const navigator: WakeLockNavigatorLike = { wakeLock: { request } };
    const controller = createWakeLockController(navigator, document, () => undefined);

    await controller.request();
    document.setVisibility('hidden');
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not reacquire after a deliberate release, even on a later visibility change', async () => {
    const document = fakeDocument();
    const sentinel = fakeSentinel();
    const request = vi.fn(async () => sentinel);
    const navigator: WakeLockNavigatorLike = { wakeLock: { request } };
    const states: WakeLockState[] = [];
    const controller = createWakeLockController(navigator, document, (state) => states.push(state));

    await controller.request();
    await controller.release();
    document.setVisibility('hidden');
    document.setVisibility('visible');
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toEqual({ kind: 'released' });
  });

  it('does not let a stale release event from an already-released sentinel overwrite the released state', async () => {
    const document = fakeDocument();
    const sentinel = fakeSentinel();
    const navigator: WakeLockNavigatorLike = { wakeLock: { request: async () => sentinel } };
    const states: WakeLockState[] = [];
    const controller = createWakeLockController(navigator, document, (state) => states.push(state));

    await controller.request();
    await controller.release();
    sentinel.fireRelease();

    expect(states).toEqual([{ kind: 'active' }, { kind: 'released' }]);
  });

  it('stops watching for visibility once disposed', async () => {
    const document = fakeDocument();
    const sentinel = fakeSentinel();
    const request = vi.fn(async () => sentinel);
    const navigator: WakeLockNavigatorLike = { wakeLock: { request } };
    const controller = createWakeLockController(navigator, document, () => undefined);

    await controller.request();
    controller.dispose();
    document.setVisibility('hidden');
    document.setVisibility('visible');
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(1);
  });

  it('releases a still-held sentinel on dispose, rather than leaving the browser holding it forever', async () => {
    const document = fakeDocument();
    const sentinel = fakeSentinel();
    const navigator: WakeLockNavigatorLike = { wakeLock: { request: async () => sentinel } };
    const controller = createWakeLockController(navigator, document, () => undefined);

    await controller.request();
    controller.dispose();
    await vi.waitFor(() => expect(sentinel.released).toBe(true));

    expect(sentinel.release).toHaveBeenCalledTimes(1);
  });
});

describe('presenting wake-lock state', () => {
  const statusOf = (): LocalOutputStatusLike => ({ textContent: null });

  it.each(LOCALES)('says the screen is being kept awake in %s', (locale) => {
    const status = statusOf();
    presentWakeLockState(status, { kind: 'active' }, locale);
    expect(status.textContent).toBe(translate(locale, 'localOutput.wakeLock.active'));
  });

  it.each(LOCALES)('says the lock was lost, and that it will be requested again, in %s', (locale) => {
    const status = statusOf();
    presentWakeLockState(status, { kind: 'lost' }, locale);
    expect(status.textContent).toBe(translate(locale, 'localOutput.wakeLock.lost'));
  });

  it('shows the neutral released state', () => {
    const status = statusOf();
    presentWakeLockState(status, { kind: 'released' }, 'en');
    expect(status.textContent).toBe(translate('en', 'localOutput.wakeLock.released'));
  });

  it('names a manual fallback for both an absent API and a denied permission', () => {
    const status = statusOf();
    presentWakeLockState(status, { kind: 'unavailable', reason: 'api-absent' }, 'en');
    expect(status.textContent).toContain('sleep settings');

    presentWakeLockState(status, { kind: 'unavailable', reason: 'denied' }, 'en');
    expect(status.textContent).toContain('sleep settings');
  });
});
