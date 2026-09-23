// The shelf an editor clears by hand (COLAB-05): every losing save left for this content, settled with
// keep-mine, keep-theirs or a combination the editor writes themselves.
//
// `combine` opens the shelved body as JSON for the editor to amend and sends back what they typed as the
// resolved body. That is deliberately plain: the shelf serves every content kind, and a merge view per
// kind would belong to that kind's editor, not here. JSON that does not parse to an object is refused
// before anything is sent, and the server still validates whatever arrives as it would any other save.
//
// A refused settlement is said out loud and left on screen: the entry is still shelved, and an editor
// who clicked and saw nothing change would assume it had worked.

import { useEffect, useState } from 'preact/hooks';

import { isShelved, parseShelfEntry, shelfKey, type ShelvedConflict } from '@holydeck/contracts/collaboration';

import { csrf } from '../app-state.js';
import { t } from '../i18n.js';
import { request } from '../request.js';

import type { JSX } from 'preact';

type Strategy = 'keep-mine' | 'keep-theirs' | 'combine';

const outstandingFrom = (value: unknown): readonly ShelvedConflict[] => {
  const raw = (value as { outstanding?: unknown } | null)?.outstanding;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((row) => {
    const parsed = parseShelfEntry(row, 'shelfEntry');
    return parsed.ok && isShelved(parsed.value) ? [parsed.value] : [];
  });
};

/** The typed text as a body, or nothing when it is not a JSON object. */
const bodyFrom = (text: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

interface ConflictShelfProps {
  readonly contentId: string;
  readonly onResolved: () => void;
}

/** Everything still shelved for one piece of content, with a settlement for each. */
export function ConflictShelf({ contentId, onResolved }: ConflictShelfProps): JSX.Element | null {
  const [outstanding, setOutstanding] = useState<readonly ShelvedConflict[]>([]);
  const [combining, setCombining] = useState<{ readonly id: string; readonly text: string }>();
  const [error, setError] = useState<string>();

  const load = async (): Promise<void> => {
    const result = await request(`/api/v1/content/${encodeURIComponent(contentId)}/conflicts`);
    if (result.ok) setOutstanding(outstandingFrom(result.data));
  };

  useEffect(() => {
    void load();
  }, [contentId]);

  const resolve = async (entry: ShelvedConflict, strategy: Strategy, resolvedBody?: Record<string, unknown>): Promise<void> => {
    setError(undefined);
    const shelfEntryId = shelfKey(entry.contentId, entry.sequence);
    const result = await request(
      `/api/v1/content/${encodeURIComponent(contentId)}/conflicts/${encodeURIComponent(shelfEntryId)}/resolve`,
      { method: 'POST', csrf: csrf() ?? '', body: resolvedBody === undefined ? { strategy } : { strategy, resolvedBody } },
    );
    if (!result.ok) {
      setError(t('conflicts.resolveFailed', { message: result.message }));
      return;
    }
    setCombining(undefined);
    onResolved();
    await load();
  };

  const combine = (entry: ShelvedConflict): void => {
    const body = bodyFrom(combining?.text ?? '');
    if (body === undefined) {
      setError(t('conflicts.combineInvalid'));
      return;
    }
    void resolve(entry, 'combine', body);
  };

  if (outstanding.length === 0) return null;

  return (
    <section class="conflict-shelf" aria-label={t('conflicts.shelfLabel')}>
      <p>{t('conflicts.shelfHeading')}</p>
      {error === undefined ? null : <p role="alert">{error}</p>}
      <ul>
        {outstanding.map((entry) => {
          const id = shelfKey(entry.contentId, entry.sequence);
          return (
            <li key={id}>
              <button type="button" onClick={() => void resolve(entry, 'keep-mine')}>
                {t('conflicts.keepMine')}
              </button>
              <button type="button" onClick={() => void resolve(entry, 'keep-theirs')}>
                {t('conflicts.keepTheirs')}
              </button>
              <button
                type="button"
                aria-expanded={combining?.id === id}
                onClick={() =>
                  setCombining(combining?.id === id ? undefined : { id, text: JSON.stringify(entry.body, null, 2) })
                }
              >
                {t('conflicts.combine')}
              </button>
              {combining?.id === id ? (
                <div>
                  <label for={`combine-${id}`}>{t('conflicts.combineLabel')}</label>
                  <textarea
                    id={`combine-${id}`}
                    rows={8}
                    value={combining.text}
                    onInput={(event) => setCombining({ id, text: (event.target as HTMLTextAreaElement).value })}
                  />
                  <button type="button" onClick={() => combine(entry)}>
                    {t('conflicts.combineSave')}
                  </button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
