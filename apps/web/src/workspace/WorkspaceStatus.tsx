// The one place a workspace says whether the last edit reached the server: a polite status line so a
// screen reader announces it without interrupting whatever an operator is doing (WS-06). `role="status"`
// sits on the save-state text alone, not the wrapping div, so a future presence update in the reserved
// collaboration slot (spec 09) does not also get announced through this live region.

import type { JSX } from 'preact';

import { t } from '../i18n.js';
import { saveState } from '../state/workspace-store.js';

const textFor = (state: typeof saveState.value): string => {
  switch (state) {
    case 'saving': return t('editor.saving');
    case 'saved': return t('editor.saved');
    case 'offline': return t('workspace.offline');
    case 'checking': return t('workspace.checking');
    default: return '';
  }
};

/** The service's save state, announced politely, plus the reserved slot spec 09 fills with who else is here. */
export function WorkspaceStatus(): JSX.Element {
  return (
    <div>
      <p role="status">{textFor(saveState.value)}</p>
      <div data-slot="collaboration" />
    </div>
  );
}
