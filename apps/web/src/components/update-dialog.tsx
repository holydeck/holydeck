// A server can retire an older client while an operator is editing a form. This dialog makes reloading
// unavoidable while keeping its sole action focused and contained; forms that use `useDraft` — currently
// the Users create form — persist safe fields with each keystroke, so reload itself has no additional work.

import { useEffect, useRef } from 'preact/hooks';

import { updateRequired } from '../app-state.js';
import { t } from '../i18n.js';

import type { JSX } from 'preact';

/** Blocks the current page until the operator reloads into the server's supported client version. */
export function UpdateDialog({ reload = () => location.reload() }: { readonly reload?: () => void }): JSX.Element | null {
  const reloadButton = useRef<HTMLButtonElement>(null);
  const shown = updateRequired.value;
  useEffect(() => {
    if (shown) reloadButton.current?.focus();
  }, [shown]);

  if (!shown) return null;
  return (
    <div class="modal-backdrop">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="update-title"
        aria-describedby="update-body"
      >
        <h2 id="update-title">{t('update.title')}</h2>
        <p id="update-body">{t('update.body')}</p>
        <button
          ref={reloadButton}
          type="button"
          onKeyDown={(event) => {
            if (event.key === 'Tab') event.preventDefault();
          }}
          onClick={reload}
        >
          {t('update.reload')}
        </button>
      </div>
    </div>
  );
}
