// The shell's own copy. The served HTML carries English so a device with no JavaScript, or one still
// fetching the bundle, reads a sentence rather than nothing; this replaces it with the language the
// device asked for before the client draws anything else.

import { type Locale, localeFor } from '@holydeck/localization/locales';
import { translate } from '@holydeck/localization/messages';

/** The two things the shell touches on the document, named so a test can stand in for a browser. */
export interface ShellDocumentLike {
  readonly documentElement: { lang: string };
  getElementById(id: string): { textContent: string | null } | null;
}

export function renderShell(doc: ShellDocumentLike, languages: readonly string[]): Locale {
  const locale = localeFor(languages);
  // Set before the copy: this is what a screen reader reads the document's language from.
  doc.documentElement.lang = locale;
  const status = doc.getElementById('status');
  if (status !== null) status.textContent = translate(locale, 'shell.preparing');
  return locale;
}
