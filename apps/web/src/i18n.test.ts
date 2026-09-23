import { afterEach, describe, expect, it } from 'vitest';

import { locale, resetAppState } from './app-state.js';
import { t, tn } from './i18n.js';

afterEach(resetAppState);

describe('t', () => {
  it('renders through the application locale rather than a locale captured by its caller', () => {
    locale.value = 'en';
    expect(t('shell.preparing')).toBe('Preparing the service view.');

    locale.value = 'de';
    expect(t('shell.preparing')).toBe('Die Gottesdienstansicht wird vorbereitet.');
  });
});

describe('tn', () => {
  it('picks the plural variant the application locale names for the count', () => {
    locale.value = 'en';
    expect(tn('service.slideCount', 1)).toBe('1 slide');
    expect(tn('service.slideCount', 3)).toBe('3 slides');
  });
});
