// The Properties panel's side-by-side look at a drifted item (WS-07): the revision the item is pinned to
// next to the newest one, read from that content's own history. It is read-only on purpose — the only
// way to move an item onto a newer revision stays the explicit Update button beside it (ADR 0005), so
// looking can never change what the service shows.

import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { API, type HistoryKind } from '../api-routes.js';
import { t } from '../i18n.js';
import { request } from '../request.js';

/** What the compare shows of one revision: its title and the labels of its parts, in order. */
export type RevisionSummary = { readonly revision: number; readonly title: string; readonly labels: readonly string[] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);
const labelsOf = (list: unknown): string[] =>
  Array.isArray(list) ? list.flatMap((entry) => (isRecord(entry) && typeof entry['label'] === 'string' ? [entry['label']] : [])) : [];

const bodyLabels = (kind: HistoryKind, body: unknown): string[] => {
  if (!isRecord(body)) return [];
  if (kind === 'song') return labelsOf(body['sections']);
  if (kind === 'slideGroup') return labelsOf(body['slides']);
  const languages = isRecord(body['languages']) ? Object.values(body['languages']) : [];
  const first = languages.find(isRecord);
  return first === undefined ? [] : strings(first['points']);
};

/** Reads a content history answer into one summary per revision. A slide group's history carries no
 *  ordinal of its own, so its place in the list (counting from one) stands in for it. */
export function readHistory(kind: HistoryKind, data: unknown): RevisionSummary[] | undefined {
  if (!Array.isArray(data)) return undefined;
  const summaries: RevisionSummary[] = [];
  for (const [index, record] of data.entries()) {
    if (!isRecord(record) || typeof record['title'] !== 'string') return undefined;
    const revision = typeof record['revision'] === 'number' ? record['revision'] : index + 1;
    summaries.push({ revision, title: record['title'], labels: bodyLabels(kind, record['body']) });
  }
  return summaries;
}

type Loaded = { readonly state: 'loading' } | { readonly state: 'failed' } | { readonly state: 'ready'; readonly history: readonly RevisionSummary[] };

const cell = (summary: RevisionSummary | undefined, pick: (found: RevisionSummary) => string): string =>
  summary === undefined ? t('drift.compare.missing') : pick(summary);

const labelList = (found: RevisionSummary): string => (found.labels.length === 0 ? t('drift.compare.none') : found.labels.join(', '));

/** Pinned against latest for one song, sermon or slide group, read from its history. */
export function ContentCompare({ kind, contentId, pinned, latest }: {
  readonly kind: HistoryKind; readonly contentId: string; readonly pinned: number; readonly latest: number;
}): JSX.Element {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });

  useEffect(() => {
    let current = true;
    setLoaded({ state: 'loading' });
    void (async (): Promise<void> => {
      const result = await request(API.contentHistory(kind, contentId));
      const history = result.ok ? readHistory(kind, result.data) : undefined;
      if (current) setLoaded(history === undefined ? { state: 'failed' } : { state: 'ready', history });
    })();
    return () => { current = false; };
  }, [kind, contentId]);

  if (loaded.state === 'loading') return <p>{t('drift.compare.loading')}</p>;
  if (loaded.state === 'failed') return <p>{t('drift.compare.unavailable')}</p>;
  const before = loaded.history.find((summary) => summary.revision === pinned);
  const after = loaded.history.find((summary) => summary.revision === latest);
  return (
    <table>
      <thead>
        <tr>
          <td />
          <th scope="col">{t('drift.compare.pinned', { n: pinned })}</th>
          <th scope="col">{t('drift.compare.latest', { n: latest })}</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <th scope="row">{t('drift.compare.title')}</th>
          <td>{cell(before, (found) => found.title)}</td>
          <td>{cell(after, (found) => found.title)}</td>
        </tr>
        <tr>
          <th scope="row">{t('drift.compare.sections')}</th>
          <td>{cell(before, labelList)}</td>
          <td>{cell(after, labelList)}</td>
        </tr>
      </tbody>
    </table>
  );
}
