// Form drafts survive a required reload without becoming another source of credentials: this narrow
// storage seam only keeps flat strings, tolerates browsers that deny storage, and excludes fields that
// could be a password or one-time code before any JSON reaches localStorage.

import { useState } from 'preact/hooks';

/** The localStorage namespace shared by form drafts and kept separate from every other browser record. */
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
    globalThis.localStorage.setItem(`${DRAFT_PREFIX}${key}`, JSON.stringify(safe));
  } catch {
    // Browser storage can be absent, full or unavailable in a private browsing context.
  }
}

/** Reads one validated form draft, treating absent, malformed or inaccessible storage as no draft. */
export function readDraft(key: string): Readonly<Record<string, string>> | undefined {
  try {
    const raw = globalThis.localStorage.getItem(`${DRAFT_PREFIX}${key}`);
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
    globalThis.localStorage.removeItem(`${DRAFT_PREFIX}${key}`);
  } catch {
    // Browser storage can be absent, full or unavailable in a private browsing context.
  }
}

/** Keeps a form draft in component state while writing each safe change for a later reload to restore. */
export function useDraft(
  key: string,
  initial: Readonly<Record<string, string>>,
): readonly [Readonly<Record<string, string>>, (next: Readonly<Record<string, string>>) => void, () => void] {
  const [draft, setDraft] = useState<Readonly<Record<string, string>>>(() => readDraft(key) ?? initial);
  const set = (next: Readonly<Record<string, string>>): void => {
    setDraft(next);
    saveDraft(key, next);
  };
  const clear = (): void => {
    clearDraft(key);
    setDraft(initial);
  };
  return [draft, set, clear];
}
