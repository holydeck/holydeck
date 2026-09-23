// WS-09's Reading editor: the Bible tab's passage fields, bound to a reading already in the service. An
// edit saves itself 800 ms after the last change (P-12), and Save Checkpoint saves now. Each field change is
// one undoable step — typing into one field in a quick run merges into a single step — and undoing or
// redoing names the field it reversed. The item's title is left alone: it is the person's to rename.

import type { MessageKey } from '@holydeck/localization/messages';
import type { JSX } from 'preact';
import { useCallback, useMemo, useRef, useState } from 'preact/hooks';

import { API } from '../api-routes.js';
import { showToast } from '../components/toast.js';
import { t } from '../i18n.js';
import { isReadOnly, mutate, service } from '../state/workspace-store.js';
import { findItem } from '../workspace/service-data.js';
import { readingIsValid, useBooks, useTranslations, type ReadingDraft } from '../workspace/tabs/bible-sources.js';
import { ReadingFields, type ReadingField } from '../workspace/tabs/ReadingFields.js';
import { createUndoStack, useUndoKeys } from './undo-stack.js';
import { useAutosave } from './use-autosave.js';

type FieldOp = { readonly field: ReadingField; readonly before: ReadingDraft; readonly after: ReadingDraft };

const FIELD_KEYS: Readonly<Record<ReadingField, MessageKey>> = {
  translation: 'bible.translation',
  compare: 'bible.compare',
  book: 'bible.book',
  chapter: 'bible.chapter',
  verses: 'bible.verses',
};

/** Changes to one field closer together than this are one undo step. */
const MERGE_WINDOW_MS = 1000;

const STATUS_KEYS: Readonly<Record<string, MessageKey | undefined>> = {
  pending: 'editor.saving',
  saving: 'editor.saving',
  saved: 'editor.saved',
  failed: 'editor.saveFailed',
};

/** Edits one reading item's passage in place. */
export function ReadingEditor({ itemId }: { readonly itemId: string }): JSX.Element | null {
  const view = service.value;
  const item = view === undefined ? undefined : findItem(view, itemId);
  const body = item?.body?.kind === 'reading' ? item.body : undefined;

  const [draft, setDraft] = useState<ReadingDraft>(() => ({
    translation: body?.translation ?? '', compare: body?.compare ?? [], book: body?.book ?? '',
    chapter: body?.chapter ?? Number.NaN, verses: body?.verses ?? '',
  }));
  const [dirty, setDirty] = useState(false);
  const stack = useMemo(() => createUndoStack<FieldOp>(), []);
  const lastChange = useRef<{ field: ReadingField; at: number } | undefined>(undefined);
  const root = useRef<HTMLDivElement>(null);

  const [translations] = useTranslations();
  const firstTranslation = translations.status === 'ready' ? translations.value[0]?.abbreviation ?? '' : '';
  // Kept stable between renders: autosave re-arms whenever the value it watches changes identity.
  const reading = useMemo(() => ({ ...draft, translation: draft.translation || firstTranslation }), [draft, firstTranslation]);
  const [books] = useBooks(reading.translation);

  const serviceId = view?.id;
  const save = useCallback(async (next: ReadingDraft): Promise<boolean> => {
    if (serviceId === undefined) return false;
    const current = service.value === undefined ? undefined : findItem(service.value, itemId)?.body;
    const slideLayout = current?.kind === 'reading' ? current.slideLayout : undefined;
    const result = await mutate(API.itemAction(serviceId, itemId, 'body'), {
      method: 'PUT', body: { kind: 'reading', ...next, ...(slideLayout === undefined ? {} : { slideLayout }) },
    });
    return result.ok;
  }, [serviceId, itemId]);

  const readOnly = isReadOnly.value;
  const { state, flush } = useAutosave(reading, save, { enabled: dirty && readingIsValid(reading) && !readOnly });

  const apply = useCallback((op: FieldOp, direction: 'undo' | 'redo'): void => {
    lastChange.current = undefined;
    setDraft(direction === 'undo' ? op.before : op.after);
    setDirty(true);
    const action = t('editor.undoField', { field: t(FIELD_KEYS[op.field]) });
    showToast({ message: t(direction === 'undo' ? 'editor.undone' : 'editor.redone', { action }) });
  }, []);
  useUndoKeys(stack, apply, root);

  if (item === undefined || item.kind !== 'reading') return null;

  const change = <F extends ReadingField>(field: F, next: ReadingDraft[F]): void => {
    const after = { ...reading, [field]: next };
    const now = Date.now();
    const previous = lastChange.current;
    let before: ReadingDraft = reading;
    if (previous !== undefined && previous.field === field && now - previous.at < MERGE_WINDOW_MS) {
      before = stack.undo()?.before ?? reading;
    }
    stack.push({ field, before, after });
    lastChange.current = { field, at: now };
    setDraft(after);
    setDirty(true);
  };

  const statusKey = STATUS_KEYS[state];
  return (
    <div class="reading-editor" ref={root}>
      <h2>{t('reading.heading')}</h2>
      <ReadingFields
        idPrefix={`reading-${itemId}`} value={reading} disabled={readOnly}
        translations={translations.status === 'ready' ? translations.value : []}
        books={books.status === 'ready' ? books.value : []}
        onChange={change}
      />
      <p role="status" class="editor-save-state">{statusKey === undefined ? '' : t(statusKey)}</p>
      <button type="button" onClick={() => void flush()}>{t('editor.checkpoint')}</button>
    </div>
  );
}
