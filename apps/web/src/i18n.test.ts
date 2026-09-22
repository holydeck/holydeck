import { afterEach, describe, expect, it } from 'vitest';

import { locale, resetAppState } from './app-state.js';
import { t } from './i18n.js';

afterEach(resetAppState);

describe('t', () => {
  it('renders through the application locale rather than a locale captured by its caller', () => {
    locale.value = 'en';
    expect(t('shell.preparing')).toBe('Preparing the service view.');

    locale.value = 'de';
    expect(t('shell.preparing')).toBe('Die Gottesdienstansicht wird vorbereitet.');
  });
});
