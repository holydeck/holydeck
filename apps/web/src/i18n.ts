// Screens translate through this small seam instead of reading a locale once while their modules load:
// changing the application locale then changes the next render without every caller carrying it around.

import { translate, type MessageKey, type MessageValues } from '@holydeck/localization/messages';

import { locale } from './app-state.js';

/** Renders one catalog message in the locale the application currently serves. */
export function t(key: MessageKey, values?: MessageValues): string {
  return translate(locale.value, key, values);
}
