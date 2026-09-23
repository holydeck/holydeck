// The Song editor's Raw YAML tab (WS-09): the song exactly as the server stores it, edited as text and
// only ever saved through the server's own validation. A refused save keeps every character typed and
// lists each problem at its line and column; choosing one puts the cursor there. The server is the source
// of truth, so a successful save hands the saved song back for the Form tab to re-read.

import { ENTITY_CONFLICT, type FieldProblem } from '@holydeck/contracts/http';
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import { API } from '../api-routes.js';
import { csrf } from '../app-state.js';
import { t } from '../i18n.js';
import { request, requestText } from '../request.js';

/** The offset of a 1-based line and column in `text`, clamped to its end. */
export function offsetOf(text: string, line: number, column: number): number {
  let offset = 0;
  for (let at = 1; at < line; at += 1) {
    const next = text.indexOf('\n', offset);
    if (next === -1) return text.length;
    offset = next + 1;
  }
  return Math.min(offset + column - 1, text.length);
}

type Loaded = { readonly status: 'loading' } | { readonly status: 'error'; readonly code: string } | { readonly status: 'ready' };

export interface RawYamlEditorProps {
  readonly songId: string;
  /** Told after every successful save, so the form can re-read the song. */
  readonly onSaved?: () => void;
  /** Told whether the text differs from what was last read or saved. */
  readonly onDirty?: (dirty: boolean) => void;
}

/** The raw YAML of one song, with server-validated save. */
export function RawYamlEditor({ songId, onSaved, onDirty }: RawYamlEditorProps): JSX.Element {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  const [problems, setProblems] = useState<readonly FieldProblem[]>([]);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let current = true;
    void requestText(API.songRaw(songId)).then((answer) => {
      if (!current) return;
      if (!answer.ok) {
        setLoaded({ status: 'error', code: answer.code });
        return;
      }
      setText(answer.data);
      setSaved(answer.data);
      setLoaded({ status: 'ready' });
    });
    return (): void => { current = false; };
  }, [songId]);

  useEffect(() => { onDirty?.(text !== saved); }, [text, saved]);

  const save = async (): Promise<void> => {
    setBusy(true);
    setRefusal(undefined);
    const answer = await request(API.songRaw(songId), { method: 'PUT', csrf: csrf() ?? '', text });
    setBusy(false);
    if (answer.ok) {
      setProblems([]);
      setSaved(text);
      onSaved?.();
      return;
    }
    setProblems(answer.fields);
    if (answer.fields.length === 0) setRefusal(answer.code);
  };

  const goTo = (problem: FieldProblem): void => {
    const field = area.current;
    if (field === null || problem.line === undefined) return;
    const offset = offsetOf(field.value, problem.line, problem.column ?? 1);
    field.focus();
    field.setSelectionRange(offset, offset);
  };

  if (loaded.status === 'loading') return <p role="status">{t('app.loading')}</p>;
  if (loaded.status === 'error') return <p role="alert">{t('add.error')} <code>{loaded.code}</code></p>;

  return (
    <div class="raw-yaml-editor">
      <label for={`raw-yaml-${songId}`}>{t('song.raw')}</label>
      <textarea
        id={`raw-yaml-${songId}`} ref={area} spellcheck={false} value={text} rows={20}
        onInput={(event) => setText(event.currentTarget.value)}
      />
      <button type="button" disabled={busy} onClick={() => void save()}>{t('song.raw.save')}</button>
      {problems.length === 0 ? null : (
        <ul class="raw-yaml-problems" role="alert">
          {problems.map((problem, index) => (
            <li key={`${problem.path}-${index}`}>
              {problem.line === undefined ? t('song.raw.problemAt', { path: problem.path, message: problem.message }) : (
                <button type="button" class="link-button" onClick={() => goTo(problem)}>
                  {t('song.raw.problem', { line: problem.line, column: problem.column ?? 1, message: problem.message })}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {refusal === undefined ? null : <p role="alert">{t(refusal === ENTITY_CONFLICT ? 'song.stale' : 'add.error')} <code>{refusal}</code></p>}
    </div>
  );
}
