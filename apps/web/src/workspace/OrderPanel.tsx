// The Order panel: the empty state Task 9 already showed, or every section and its items. It never
// renders a position the server has not confirmed — a move keeps its old place, marked busy, until the
// answer arrives (`order-actions.ts`) — and a section edit (rename, add, remove) always sends the whole
// draft, because `parseServiceDraft` requires `title`/`date`/`site` even when only `sections` changed.

import { useCallback, useState } from 'preact/hooks';

import type { ServiceSection } from '@holydeck/contracts/services';
import type { JSX } from 'preact';

import { API } from '../api-routes.js';
import { useAutosave } from '../editors/use-autosave.js';
import { t } from '../i18n.js';
import { bulkSelecting, isReadOnly, mutate, service } from '../state/workspace-store.js';
import { BulkBar, leaveSelectionMode } from './BulkBar.js';
import { dropTarget } from './order-actions.js';
import { OrderItem } from './OrderItem.js';
import { addSection, removeSection, renameSection } from './order-ops.js';
import { itemsOf, type ServiceView } from './service-data.js';
import { WindowedList } from './windowed-list.js';

/** PATCHes the sections `sectionsFor` computes, alongside the service's unchanged facts. Both are read
 *  only once the write leaves the store's queue, so an item body saved just before is carried, not reverted. */
async function patchSections(sectionsFor: (current: ServiceView) => ServiceView['sections']): Promise<boolean> {
  const current = service.value;
  if (current === undefined) return false;
  const result = await mutate(API.service(current.id), {
    method: 'PATCH',
    bodyFor: (latest) => ({ title: latest.title, date: latest.date, site: latest.site, sections: sectionsFor(latest) }),
  });
  return result.ok;
}

function SectionRenameField({ sectionId, name, onDone }: {
  readonly sectionId: string;
  readonly name: string;
  readonly onDone: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState(name);
  // Kept stable, and only armed while the draft differs from the saved name: an unstable `save` re-arms
  // autosave on every render, and each answered PATCH re-renders, so the same name would be sent forever.
  const save = useCallback(
    (value: string) => patchSections((current) => renameSection(current, sectionId, value)),
    [sectionId],
  );
  const { flush } = useAutosave(draft, save, { enabled: draft !== name });

  return (
    <input
      aria-label={t('order.section.rename')}
      value={draft}
      onInput={(event) => setDraft(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onDone();
        } else if (event.key === 'Enter') {
          event.preventDefault();
          void flush().then(onDone);
        }
      }}
    />
  );
}

function Section({ section, readOnly }: { readonly section: ServiceSection; readonly readOnly: boolean }): JSX.Element {
  const [expanded, setExpanded] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const itemsId = `order-section-items-${section.id}`;

  const removeThisSection = async (): Promise<void> => {
    const current = service.value;
    if (current === undefined) return;
    const result = removeSection(current, section.id);
    if (result === 'not-empty') {
      setNotice(t('order.section.notEmpty'));
      return;
    }
    setNotice(undefined);
    await patchSections((latest) => {
      const removed = removeSection(latest, section.id);
      return removed === 'not-empty' ? latest.sections : removed;
    });
  };

  return (
    // Dropping anywhere in the section but on a row puts the item at its end — an empty section included.
    <div class="order-section" {...dropTarget({ sectionId: section.id, index: section.items.length })}>
      <div class="order-section-header">
        <button type="button" aria-expanded={expanded} aria-controls={itemsId} onClick={() => setExpanded(!expanded)}>
          {section.name}
        </button>
        {renaming ? (
          <SectionRenameField sectionId={section.id} name={section.name} onDone={() => setRenaming(false)} />
        ) : (
          <button type="button" disabled={readOnly} onClick={() => setRenaming(true)}>{t('order.section.rename')}</button>
        )}
        <button type="button" disabled={readOnly} onClick={() => void removeThisSection()}>{t('order.section.remove')}</button>
      </div>
      {notice === undefined ? null : <p role="alert">{notice}</p>}
      {/* Windowing trades one thing away deliberately: an item mid-way through a long section that a
          caller expands but never focuses can still scroll out of the mounted window, because
          `WindowedList` only guarantees the row currently holding DOM focus stays rendered. Expanding a
          row happens by clicking its own expand button, which leaves that button focused, so in practice
          the row that was just expanded is kept — but a row expanded once, then left unfocused after
          scrolling elsewhere, is not specially pinned beyond that. */}
      {/* `role="list"` rather than `<ol>`: the windowing wrappers between the list and its `<li>` rows are
          presentational, which ARIA flattens, but an `<ol>` may only hold `<li>` children directly. */}
      <div role="list" id={itemsId} hidden={!expanded}>
        <WindowedList
          items={section.items}
          rowHeightPx={48}
          keyOf={(item) => item.id}
          render={(item, index) => (
            <OrderItem key={item.id} sectionId={section.id} item={item} index={index} total={section.items.length} />
          )}
        />
      </div>
    </div>
  );
}

/** The Order panel Task 9 left a placeholder for: the same empty state, or every section and its items. */
export function OrderPanel({ view, onEmpty }: { readonly view: ServiceView; readonly onEmpty: () => void }): JSX.Element {
  const readOnly = isReadOnly.value;
  const selecting = bulkSelecting.value;

  const addNewSection = (): void => {
    void patchSections((current) => addSection(current, t('order.section.new'), globalThis.crypto.randomUUID()));
  };

  if (itemsOf(view).length === 0) {
    // A blank service starts with no section, and every Add tab inserts into one: offer the first here.
    return (
      <div>
        <p>{t('workspace.empty')}</p>
        {view.sections.length === 0 ? (
          <button type="button" disabled={readOnly} onClick={addNewSection}>{t('order.section.add')}</button>
        ) : null}{' '}
        <button type="button" onClick={onEmpty}>{t('workspace.empty.add')}</button>
      </div>
    );
  }

  return (
    <div class="order-panel">
      <div class="order-panel-header">
        <button
          type="button"
          aria-pressed={selecting}
          disabled={readOnly}
          onClick={() => { if (selecting) leaveSelectionMode(); else bulkSelecting.value = true; }}
        >
          {t('bulk.select')}
        </button>
      </div>
      {view.sections.map((section) => <Section key={section.id} section={section} readOnly={readOnly} />)}
      <button
        type="button"
        disabled={readOnly}
        onClick={addNewSection}
      >
        {t('order.section.add')}
      </button>
      {selecting ? <BulkBar view={view} /> : null}
    </div>
  );
}
