// OUI-05: from the service's live page, after a run ends, what it showed (`run-review.ts`'s review) and
// an optional recap (`run-review.ts`'s recap) — for the latest ended run of this service. Review and
// recap are gated exactly as `run-routes.ts` gates their routes: review needs `presentation.control`
// alone, recap needs `presentation.control` or `service.read` — the two sections below check their own
// permission independently, so a `service.read`-only viewer can reach a recap without ever seeing the
// review list. Nothing here decides which runs are rehearsals or excludes one from a recap; the server
// already does both (RUN-06), and the only lever this screen has is the `includeRehearsal` request an
// operator can choose to send.
//
// Finding "the latest ended run" never assumes the server's list is already sorted: it is read and sorted
// here by `endedAt`, which sorts correctly as a plain string because it is ISO-8601.

import { useEffect, useState } from 'preact/hooks';

import { API } from '../api-routes.js';
import { can, locale } from '../app-state.js';
import { t } from '../i18n.js';
import { request, requestText } from '../request.js';

import type { JSX } from 'preact';

type Format = 'md' | 'text';

const EXTENSION: Readonly<Record<Format, string>> = { md: 'md', text: 'txt' };
const MIME: Readonly<Record<Format, string>> = { md: 'text/markdown', text: 'text/plain' };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const dateTimeOf = (at: string): string =>
  new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));

interface RunSummary {
  readonly runId: string;
  readonly mode: string;
  readonly endedAt: string;
}

const parsedRun = (value: unknown): RunSummary | undefined => {
  if (!isRecord(value)) return undefined;
  const { runId, mode, endedAt } = value;
  if (typeof runId !== 'string' || typeof mode !== 'string' || typeof endedAt !== 'string') return undefined;
  return { runId, mode, endedAt };
};

const parsedRuns = (value: unknown): readonly RunSummary[] =>
  Array.isArray(value) ? value.flatMap((row) => { const run = parsedRun(row); return run === undefined ? [] : [run]; }) : [];

/** The run this service ended most recently, from a list the server never promises is already ordered. */
const latestEnded = (runs: readonly RunSummary[]): RunSummary | undefined =>
  runs.slice().sort((a, b) => b.endedAt.localeCompare(a.endedAt))[0];

interface ReviewedReferenceView {
  readonly sequence: number;
  readonly at: string;
  readonly actor: string;
  readonly reference: string;
}

const parsedReference = (value: unknown): ReviewedReferenceView | undefined => {
  if (!isRecord(value)) return undefined;
  const { sequence, at, actor, reference } = value;
  if (typeof sequence !== 'number' || typeof at !== 'string' || typeof actor !== 'string' || typeof reference !== 'string') {
    return undefined;
  }
  return { sequence, at, actor, reference };
};

const parsedReferences = (value: unknown): readonly ReviewedReferenceView[] =>
  Array.isArray(value)
    ? value.flatMap((row) => { const reference = parsedReference(row); return reference === undefined ? [] : [reference]; })
    : [];

/** What this run showed, oldest first, exactly as `runReview.review` answers it. */
function RunReviewList({ runId }: { readonly runId: string }): JSX.Element {
  const [references, setReferences] = useState<readonly ReviewedReferenceView[] | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let current = true;
    setReferences(undefined);
    setFailed(false);
    void request(API.runReview(runId)).then((result) => {
      if (!current) return;
      if (!result.ok) {
        setFailed(true);
        return;
      }
      setReferences(parsedReferences(result.data));
    });
    return () => {
      current = false;
    };
  }, [runId]);

  return (
    <div>
      <h3>{t('run.review.heading')}</h3>
      {failed ? <p role="alert">{t('run.review.loadFailed')}</p> : null}
      {!failed && references === undefined ? <p role="status">{t('app.loading')}</p> : null}
      {references !== undefined && references.length === 0 ? <p>{t('run.review.empty')}</p> : null}
      {references !== undefined && references.length > 0 ? (
        <ol>
          {references.map((reference) => (
            <li key={reference.sequence}>
              {t('run.review.item', { reference: reference.reference, actor: reference.actor, at: dateTimeOf(reference.at) })}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

/** The optional recap: text or Markdown, copyable and downloadable, rehearsal excluded unless asked for. */
function RunRecap({ runId, rehearsal }: { readonly runId: string; readonly rehearsal: boolean }): JSX.Element {
  const [format, setFormat] = useState<Format>('md');
  const [includeRehearsal, setIncludeRehearsal] = useState(false);
  const [text, setText] = useState<string | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    let current = true;
    setText(undefined);
    setFailed(false);
    setCopyStatus('idle');
    void requestText(API.runRecap(runId, { format, includeRehearsal })).then((result) => {
      if (!current) return;
      if (!result.ok) {
        setFailed(true);
        return;
      }
      setText(result.data);
    });
    return () => {
      current = false;
    };
  }, [runId, format, includeRehearsal]);

  const copy = async (): Promise<void> => {
    if (text === undefined) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    }
  };

  const download = (): void => {
    if (text === undefined) return;
    const address = URL.createObjectURL(new Blob([text], { type: MIME[format] }));
    const link = document.createElement('a');
    link.href = address;
    link.download = `run-${runId}-recap.${EXTENSION[format]}`;
    link.click();
    URL.revokeObjectURL(address);
  };

  const empty = text !== undefined && text.trim() === '';

  return (
    <div>
      <h3>{t('run.recap.heading')}</h3>
      <div class="form-field">
        <label for="run-recap-format">{t('run.recap.formatLabel')}</label>
        <select
          id="run-recap-format"
          value={format}
          onChange={(event) => setFormat(event.currentTarget.value as Format)}
        >
          <option value="md">{t('run.recap.format.md')}</option>
          <option value="text">{t('run.recap.format.text')}</option>
        </select>
      </div>
      {rehearsal ? (
        <label>
          <input
            type="checkbox"
            checked={includeRehearsal}
            onChange={(event) => setIncludeRehearsal(event.currentTarget.checked)}
          />
          {t('run.recap.includeRehearsal')}
        </label>
      ) : null}
      {failed ? <p role="alert">{t('run.recap.loadFailed')}</p> : null}
      {!failed && text === undefined ? <p role="status">{t('app.loading')}</p> : null}
      {empty ? <p>{t('run.recap.empty')}</p> : null}
      {text !== undefined && !empty ? <pre>{text}</pre> : null}
      <button type="button" disabled={text === undefined || empty} onClick={() => void copy()}>
        {t('run.recap.copy')}
      </button>
      <button type="button" disabled={text === undefined || empty} onClick={download}>
        {t('run.recap.download')}
      </button>
      {copyStatus === 'copied' ? <p role="status">{t('run.recap.copied')}</p> : null}
      {copyStatus === 'failed' ? <p role="alert">{t('run.recap.copyFailed')}</p> : null}
    </div>
  );
}

export interface RunReviewProps {
  readonly serviceId: string;
}

/** Mounted on the service's live page (OUI-05): nothing to show until this service has an ended run, and
 * nothing at all for a session holding neither of the two permissions either section needs. */
export function RunReview({ serviceId }: RunReviewProps): JSX.Element | null {
  const canReview = can('presentation.control');
  const canRecap = can('presentation.control') || can('service.read');

  const [run, setRun] = useState<RunSummary | undefined>(undefined);
  const [listFailed, setListFailed] = useState(false);

  useEffect(() => {
    if (!canReview && !canRecap) return undefined;
    let current = true;
    setRun(undefined);
    setListFailed(false);
    void request(API.runs({ serviceId, phase: 'ended' })).then((result) => {
      if (!current) return;
      if (!result.ok) {
        setListFailed(true);
        return;
      }
      setRun(latestEnded(parsedRuns(result.data)));
    });
    return () => {
      current = false;
    };
  }, [serviceId, canReview, canRecap]);

  if (!canReview && !canRecap) return null;
  if (listFailed) return <p role="alert">{t('run.list.loadFailed')}</p>;
  if (run === undefined) return null;

  return (
    <section aria-labelledby="run-review-heading">
      <h2 id="run-review-heading">{t('run.section.heading')}</h2>
      {run.mode === 'rehearsal' ? <p>{t('run.section.rehearsal')}</p> : null}
      {canReview ? <RunReviewList runId={run.runId} /> : null}
      {canRecap ? <RunRecap runId={run.runId} rehearsal={run.mode === 'rehearsal'} /> : null}
    </section>
  );
}
