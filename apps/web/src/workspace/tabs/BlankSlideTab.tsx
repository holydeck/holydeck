// The Add panel's Blank Slide source (WS-08): an empty custom slide, inserted where `InsertLocation` says and
// selected at once so the person lands on it ready to design. The canvas that edits it is Task 20's.

import type { JSX } from 'preact';
import { useState } from 'preact/hooks';

import { t } from '../../i18n.js';
import { isReadOnly } from '../../state/workspace-store.js';
import { insertAndSelect, InsertLocation, useInsertTarget } from '../InsertLocation.js';

/** The location picker and the one button that inserts an empty custom slide. */
export function BlankSlideTab(): JSX.Element {
  const [target, setTarget] = useInsertTarget();
  const [busy, setBusy] = useState(false);

  const insert = async (): Promise<void> => {
    if (target === undefined) return;
    setBusy(true);
    const inserted = await insertAndSelect(target, {
      id: globalThis.crypto.randomUUID(), kind: 'custom-slide', title: t('blank.title'), enabled: true,
      content: undefined, body: { kind: 'custom-slide', boxes: [] },
    });
    if (inserted) setTarget(undefined);
    setBusy(false);
  };

  return (
    <div class="blank-slide-tab">
      <InsertLocation idPrefix="blank-insert" value={target} onChange={setTarget} />
      <button type="button" disabled={target === undefined || isReadOnly.value || busy} onClick={() => void insert()}>
        {t('blank.insert')}
      </button>
    </div>
  );
}
