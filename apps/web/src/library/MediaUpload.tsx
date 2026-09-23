// The media library's way in (WS-12): a file picker and a drop zone that feed the same queue. Each file
// is checked against the deployment's upload limit and the accepted types before anything is sent, then
// uploaded one at a time with its progress shown. A size refusal from the server is explained as the
// storage reserve it protects, with a way to review storage; any other refusal says what every workspace
// refusal says for its code (refusal-text.ts), the code itself only where no sentence names it.

import { VALIDATION_FAILED } from '@holydeck/contracts/http';
import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { t } from '../i18n.js';
import { refusalText } from '../refusal-text.js';
import { loadOutputDefaults, outputDefaults } from '../workspace/output-defaults.js';
import { ACCEPTED_TYPES, formatBytes, precheck, uploadMedia } from './upload.js';

/** The code the server answers a file over its size ceiling with (HTTP 413). */
export const TOO_LARGE_CODE = 'media.too_large';

type Outcome =
  | { readonly kind: 'too-large' | 'wrong-type' | 'reserve'; readonly name: string }
  | { readonly kind: 'refused'; readonly name: string; readonly code: string };

/** The upload control: choose or drop files, see each one's progress and any refusal. */
export function MediaUpload({ onUploaded }: { readonly onUploaded: () => void }): JSX.Element {
  const [progress, setProgress] = useState<{ readonly name: string; readonly percent: number } | undefined>(undefined);
  const [outcomes, setOutcomes] = useState<readonly Outcome[]>([]);
  const [over, setOver] = useState(false);

  useEffect(() => {
    void loadOutputDefaults();
  }, []);

  const send = async (files: readonly File[]): Promise<void> => {
    const limit = outputDefaults.value?.uploadLimitBytes ?? Number.POSITIVE_INFINITY;
    const found: Outcome[] = [];
    let sent = false;
    for (const file of files) {
      const checked = precheck(file, limit, ACCEPTED_TYPES);
      if (checked !== 'ok') {
        found.push({ kind: checked, name: file.name });
        continue;
      }
      setProgress({ name: file.name, percent: 0 });
      const answer = await uploadMedia(file, (done, total) => setProgress({ name: file.name, percent: Math.round((done / total) * 100) }));
      if (answer.ok) sent = true;
      else if (answer.code === TOO_LARGE_CODE) found.push({ kind: 'reserve', name: file.name });
      else if (answer.code === VALIDATION_FAILED) found.push({ kind: 'wrong-type', name: file.name });
      else found.push({ kind: 'refused', name: file.name, code: answer.code });
    }
    setProgress(undefined);
    setOutcomes(found);
    if (sent) onUploaded();
  };

  const limit = outputDefaults.value?.uploadLimitBytes;

  return (
    <section class="media-upload" aria-labelledby="media-upload-heading">
      <h2 id="media-upload-heading">{t('mediaLib.upload')}</h2>
      <label
        class={over ? 'drop-zone over' : 'drop-zone'}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          void send([...(event.dataTransfer?.files ?? [])]);
        }}
      >
        {t('mediaLib.drop')}
        <input
          type="file"
          multiple
          accept={ACCEPTED_TYPES.join(',')}
          onChange={(event) => {
            const files = [...(event.currentTarget.files ?? [])];
            event.currentTarget.value = '';
            void send(files);
          }}
        />
      </label>
      {progress === undefined ? null : (
        <p role="status">
          <span class="truncate" title={progress.name}>{progress.name}</span>{' '}
          <progress max={100} value={progress.percent} aria-label={progress.name} />{' '}
          {t('mediaLib.progress', { percent: progress.percent })}
        </p>
      )}
      {outcomes.length === 0 ? null : (
        <ul role="alert" class="upload-refusals">
          {outcomes.map((outcome, index) => (
            <li key={index}>
              <span class="truncate" title={outcome.name}>{outcome.name}</span>{': '}
              {outcome.kind === 'too-large' ? t('mediaLib.tooLarge', { limit: formatBytes(limit ?? 0) })
                : outcome.kind === 'wrong-type' ? t('mediaLib.wrongType')
                : outcome.kind === 'reserve' ? <>{t('mediaLib.reserve')} <a href="/admin/storage">{t('mediaLib.reviewStorage')}</a></>
                : refusalText({ code: 'code' in outcome ? outcome.code : '' })}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
