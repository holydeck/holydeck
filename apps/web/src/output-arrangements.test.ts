import { describe, expect, it, vi } from 'vitest';

import { LOCALES } from '@holydeck/localization/locales';
import { translate } from '@holydeck/localization/messages';

import {
  getDeviceId,
  listArrangements,
  loadArrangement,
  presentArrangementPreview,
  previewArrangement,
  reopenArrangement,
  saveArrangement,
} from './output-arrangements.js';

import type { ArrangementPreviewStatusLike, SavedArrangement, StorageLike } from './output-arrangements.js';
import type { DetectedScreen, ScreenDetection } from './output-launch.js';

const screenAt = (overrides: Partial<DetectedScreen> = {}): DetectedScreen => ({
  left: 0,
  top: 0,
  width: 1920,
  height: 1080,
  isPrimary: false,
  ...overrides,
});

const fakeStorage = (initial: Record<string, string> = {}): StorageLike => {
  const data = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
  };
};

describe('the per-device identifier', () => {
  it('creates one the first time none is stored, and persists it', () => {
    const storage = fakeStorage();
    const id = getDeviceId(storage, { randomUUID: () => 'device-1' });
    expect(id).toBe('device-1');
    expect(storage.setItem).toHaveBeenCalledWith('holydeck.deviceId', 'device-1');
  });

  it('reads back the same id on a later call rather than creating a new one', () => {
    const storage = fakeStorage();
    const first = getDeviceId(storage, { randomUUID: () => 'device-1' });
    const second = getDeviceId(storage, { randomUUID: () => 'device-2' });
    expect(second).toBe(first);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it('still creates a usable id when no randomUUID source is available', () => {
    const storage = fakeStorage();
    const id = getDeviceId(storage);
    expect(id.length).toBeGreaterThan(0);
    expect(storage.getItem('holydeck.deviceId')).toBe(id);
  });
});

describe('saving and loading a named arrangement', () => {
  it('round-trips a saved arrangement for the device that saved it', () => {
    const storage = fakeStorage();
    const screens = [screenAt(), screenAt({ left: 1920 })];
    saveArrangement(storage, 'device-1', 'Sunday', screens);
    expect(loadArrangement(storage, 'device-1', 'Sunday')).toEqual({ name: 'Sunday', screens });
  });

  it('returns undefined for a name this device never saved', () => {
    const storage = fakeStorage();
    expect(loadArrangement(storage, 'device-1', 'missing')).toBeUndefined();
  });

  it('keeps arrangements saved under other names untouched, and a later save replaces only its own name', () => {
    const storage = fakeStorage();
    saveArrangement(storage, 'device-1', 'Sunday', [screenAt()]);
    saveArrangement(storage, 'device-1', 'Wednesday', [screenAt({ left: 1920 })]);
    saveArrangement(storage, 'device-1', 'Sunday', [screenAt({ top: 40 })]);

    expect(loadArrangement(storage, 'device-1', 'Wednesday')?.screens).toEqual([screenAt({ left: 1920 })]);
    expect(loadArrangement(storage, 'device-1', 'Sunday')?.screens).toEqual([screenAt({ top: 40 })]);
  });

  it('keeps two devices independent', () => {
    const storage = fakeStorage();
    saveArrangement(storage, 'device-1', 'Sunday', [screenAt()]);
    expect(loadArrangement(storage, 'device-2', 'Sunday')).toBeUndefined();
  });

  it('lists every arrangement a device has saved', () => {
    const storage = fakeStorage();
    saveArrangement(storage, 'device-1', 'Sunday', [screenAt()]);
    saveArrangement(storage, 'device-1', 'Wednesday', [screenAt({ left: 1920 })]);
    expect(listArrangements(storage, 'device-1').map((arrangement) => arrangement.name).sort()).toEqual([
      'Sunday',
      'Wednesday',
    ]);
  });

  it('reads corrupted storage as no saved arrangements rather than throwing', () => {
    const storage = fakeStorage({ 'holydeck.output-arrangements.device-1': 'not json{' });
    expect(loadArrangement(storage, 'device-1', 'Sunday')).toBeUndefined();
    expect(listArrangements(storage, 'device-1')).toEqual([]);
  });

  it('reads storage holding well-formed JSON of the wrong shape as no saved arrangements too', () => {
    const storage = fakeStorage({ 'holydeck.output-arrangements.device-1': JSON.stringify({ Sunday: 'not a list' }) });
    expect(loadArrangement(storage, 'device-1', 'Sunday')).toBeUndefined();
  });

  it('reads a screen list holding something other than a screen record as no saved arrangements too', () => {
    const storage = fakeStorage({
      'holydeck.output-arrangements.device-1': JSON.stringify({ Sunday: ['not a screen', null] }),
    });
    expect(loadArrangement(storage, 'device-1', 'Sunday')).toBeUndefined();
  });
});

describe('previewing what an arrangement would open', () => {
  it('matches every saved screen still reported by detection, in Audience/Stage/Singer order', () => {
    const primary = screenAt({ isPrimary: true });
    const secondary = screenAt({ left: 1920 });
    const arrangement: SavedArrangement = { name: 'Sunday', screens: [primary, secondary] };
    const detection: ScreenDetection = { kind: 'detected', screens: [primary, secondary] };

    expect(previewArrangement(arrangement, detection)).toEqual([
      { view: 'audience', screen: primary },
      { view: 'stage', screen: secondary },
      { view: 'singer', screen: undefined },
    ]);
  });

  it('degrades a surface to no screen when its saved screen is no longer detected', () => {
    const arrangement: SavedArrangement = { name: 'Sunday', screens: [screenAt(), screenAt({ left: 1920 })] };
    const detection: ScreenDetection = { kind: 'detected', screens: [screenAt()] };

    const preview = previewArrangement(arrangement, detection);
    expect(preview[0]).toEqual({ view: 'audience', screen: screenAt() });
    expect(preview[1]).toEqual({ view: 'stage', screen: undefined });
  });

  it('treats detection being unavailable as no screens matching at all', () => {
    const arrangement: SavedArrangement = { name: 'Sunday', screens: [screenAt()] };
    const preview = previewArrangement(arrangement, { kind: 'unavailable', reason: 'api-absent' });
    expect(preview[0]).toEqual({ view: 'audience', screen: undefined });
  });
});

describe('reopening an arrangement in one action', () => {
  it('opens every output surface from a single call, each on its matched screen', () => {
    const open = vi.fn(() => ({}));
    const primary = screenAt({ isPrimary: true });
    const secondary = screenAt({ left: 1920 });
    const arrangement: SavedArrangement = { name: 'Sunday', screens: [primary, secondary] };
    const detection: ScreenDetection = { kind: 'detected', screens: [primary, secondary] };

    const launches = reopenArrangement({ open }, arrangement, detection, (view) => `/live/${view}`);

    expect(launches).toEqual([
      { kind: 'launched', view: 'audience', placement: 'screen' },
      { kind: 'launched', view: 'stage', placement: 'screen' },
      { kind: 'launched', view: 'singer', placement: 'manual' },
    ]);
    expect(open).toHaveBeenCalledTimes(3);
    expect(open).toHaveBeenCalledWith(
      '/live/audience',
      'holydeck-output-audience',
      'left=0,top=0,width=1920,height=1080',
    );
    expect(open).toHaveBeenCalledWith('/live/singer', 'holydeck-output-singer', undefined);
  });

  it('degrades to the manual fallback for a surface whose saved screen is now absent, rather than failing opaquely', () => {
    const open = vi.fn(() => ({}));
    const arrangement: SavedArrangement = { name: 'Sunday', screens: [screenAt(), screenAt({ left: 1920 })] };
    // The screen Stage was saved with (left: 1920) is gone; only the first screen is still detected.
    const detection: ScreenDetection = { kind: 'detected', screens: [screenAt()] };

    const launches = reopenArrangement({ open }, arrangement, detection, (view) => `/live/${view}`);

    expect(launches[1]).toEqual({ kind: 'launched', view: 'stage', placement: 'manual' });
    expect(open).toHaveBeenCalledWith('/live/stage', 'holydeck-output-stage', undefined);
  });

  it('degrades every surface to manual placement when screen detection itself is unavailable', () => {
    const open = vi.fn(() => ({}));
    const arrangement: SavedArrangement = { name: 'Sunday', screens: [screenAt(), screenAt({ left: 1920 })] };

    const launches = reopenArrangement(
      { open },
      arrangement,
      { kind: 'unavailable', reason: 'permission-denied' },
      (view) => `/live/${view}`,
    );

    expect(launches.every((launch) => launch.kind === 'launched' && launch.placement === 'manual')).toBe(true);
  });

  it('still opens every surface it can even when one is blocked by the popup policy', () => {
    const open = vi.fn((_url: string, target: string) => (target === 'holydeck-output-stage' ? null : {}));
    const arrangement: SavedArrangement = { name: 'Sunday', screens: [screenAt(), screenAt({ left: 1920 })] };
    const detection: ScreenDetection = { kind: 'detected', screens: [screenAt(), screenAt({ left: 1920 })] };

    const launches = reopenArrangement({ open }, arrangement, detection, (view) => `/live/${view}`);

    expect(launches[0]).toEqual({ kind: 'launched', view: 'audience', placement: 'screen' });
    expect(launches[1]).toEqual({ kind: 'blocked', view: 'stage' });
    expect(launches[2]).toEqual({ kind: 'launched', view: 'singer', placement: 'manual' });
  });
});

describe('saving then reopening an arrangement end to end', () => {
  it('one saved arrangement reopens every one of its surfaces from a single call', () => {
    const storage = fakeStorage();
    const deviceId = getDeviceId(storage, { randomUUID: () => 'device-1' });
    const screens = [screenAt({ isPrimary: true }), screenAt({ left: 1920 })];
    saveArrangement(storage, deviceId, 'Sunday', screens);

    const arrangement = loadArrangement(storage, deviceId, 'Sunday');
    expect(arrangement).toBeDefined();
    if (arrangement === undefined) throw new Error('unreachable');

    const open = vi.fn(() => ({}));
    const launches = reopenArrangement(
      { open },
      arrangement,
      { kind: 'detected', screens },
      (view) => `/live/${view}`,
    );

    expect(launches.every((launch) => launch.kind === 'launched')).toBe(true);
    expect(open).toHaveBeenCalledTimes(3);
  });
});

describe('presenting a preview entry', () => {
  it.each(LOCALES)('says a surface will open on its saved screen, in %s', (locale) => {
    const status: ArrangementPreviewStatusLike = { textContent: null };
    presentArrangementPreview(status, { view: 'audience', screen: screenAt() }, locale);
    expect(status.textContent).toBe(
      translate(locale, 'arrangement.preview.screen', { view: translate(locale, 'output.channel.audience') }),
    );
  });

  it.each(LOCALES)('says a surface will open without its saved screen, in %s', (locale) => {
    const status: ArrangementPreviewStatusLike = { textContent: null };
    presentArrangementPreview(status, { view: 'stage', screen: undefined }, locale);
    expect(status.textContent).toBe(
      translate(locale, 'arrangement.preview.manual', { view: translate(locale, 'output.channel.stage') }),
    );
  });
});
