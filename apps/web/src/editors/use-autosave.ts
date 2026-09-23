// An editor's changes wait briefly for the user to finish typing before they save, while a narrow draft
// mirror keeps unsaved flat form values recoverable if the page goes away before the server accepts them.

import { useEffect, useRef, useState } from 'preact/hooks';

import { clearDraft, saveDraft } from '../drafts.js';

type AutosaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'failed';

/** Debounces saves for one editor value and lets its checkpoint action save the current value immediately. */
export function useAutosave<T>(
  value: T,
  save: (value: T) => Promise<boolean>,
  options: { delayMs?: number; draftKey?: string; enabled?: boolean } = {},
): { state: AutosaveState; flush: () => Promise<void> } {
  const { delayMs = 800, draftKey, enabled = true } = options;
  const [state, setState] = useState<AutosaveState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const current = useRef(true);
  const revision = useRef(0);

  const saveNow = async (next: T, savedRevision: number): Promise<void> => {
    setState('saving');
    let saved: boolean;
    try {
      saved = await save(next);
    } catch {
      saved = false;
    }
    if (!current.current || revision.current !== savedRevision) return;
    setState(saved ? 'saved' : 'failed');
    if (saved && draftKey !== undefined) clearDraft(draftKey);
  };

  useEffect(() => () => {
    current.current = false;
    if (timer.current !== undefined) clearTimeout(timer.current);
  }, []);

  useEffect(() => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    revision.current += 1;
    const savedRevision = revision.current;
    if (!enabled) {
      setState('idle');
      return;
    }
    setState('pending');
    timer.current = setTimeout(() => {
      timer.current = undefined;
      return saveNow(value, savedRevision);
    }, delayMs);
    return () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
    };
  }, [value, enabled, delayMs, save]);

  useEffect(() => {
    if (draftKey === undefined) return;
    if (state === 'pending' || state === 'saving' || state === 'failed') {
      saveDraft(draftKey, value as Readonly<Record<string, string>>);
    }
  }, [draftKey, state, value]);

  const flush = async (): Promise<void> => {
    if (!enabled) return;
    if (timer.current !== undefined) clearTimeout(timer.current);
    revision.current += 1;
    await saveNow(value, revision.current);
  };

  return { state, flush };
}
