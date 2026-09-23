// Form drafts survive a required reload without becoming another source of credentials: this narrow
// storage seam only keeps flat strings, tolerates browsers that deny storage, and excludes fields that
// could be a password or one-time code before any JSON reaches sessionStorage. Drafts belong only to
// this tab, so they cannot outlive it or be read by the next account using a shared browser.

import { useState } from 'preact/hooks';

/** The sessionStorage namespace shared by form drafts, isolated to this tab and its current account boundary. */
export const DRAFT_PREFIX = 'holydeck:draft:';

const isSafeField = (name: string): boolean => !/(?:password|code)/iu.test(name);

const isDraft = (value: unknown): value is Readonly<Record<string, string>> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value as Record<string, unknown>).every((entry) => typeof entry === 'string');

/**
 * Persists one form's safe string fields. Password and code names are deliberately omitted: a reload
 * convenience must never turn a credential or short-lived second factor into browser storage.
 */
export function saveDraft(key: string, value: Readonly<Record<string, string>>): void {
  try {
    const safe = Object.fromEntries(Object.entries(value).filter(([name]) => isSafeField(name)));
    globalThis.sessionStorage.setItem(`${DRAFT_PREFIX}${key}`, JSON.stringify(safe));
  } catch {
    // Browser storage can be absent, full or unavailable in a private browsing context.
  }
}

/** Reads one validated form draft, treating absent, malformed or inaccessible storage as no draft. */
export function readDraft(key: string): Readonly<Record<string, string>> | undefined {
  try {
    const raw = globalThis.sessionStorage.getItem(`${DRAFT_PREFIX}${key}`);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return isDraft(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Removes one saved form draft, without letting a browser storage failure interrupt the form itself. */
export function clearDraft(key: string): void {
  try {
    globalThis.sessionStorage.removeItem(`${DRAFT_PREFIX}${key}`);
  } catch {
    // Browser storage can be absent, full or unavailable in a private browsing context.
  }
}

/** Removes every form draft from this tab when its account boundary ends, ignoring storage failures. */
export function clearAllDrafts(): void {
  let keys: string[];
  try {
    const storage = globalThis.sessionStorage;
    keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key): key is string => key?.startsWith(DRAFT_PREFIX) ?? false);
  } catch {
    // Browser storage can be absent, full or unavailable in a private browsing context.
    return;
  }
  for (const key of keys) {
    try {
      globalThis.sessionStorage.removeItem(key);
    } catch {
      // One inaccessible record must not leave the rest of this tab's drafts behind.
    }
  }
}

/** Keeps a form draft in component state while writing each safe change for a later reload to restore. */
export function useDraft<T extends Readonly<Record<string, string>>>(
  key: string,
  initial: T,
): readonly [T, (next: T) => void, () => void] {
  const [draft, setDraft] = useState<T>(() => ({ ...initial, ...(readDraft(key) ?? {}) }));
  const set = (next: T): void => {
    setDraft(next);
    saveDraft(key, next);
  };
  const clear = (): void => {
    clearDraft(key);
    setDraft(initial);
  };
  return [draft, set, clear];
}
