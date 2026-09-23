// WS-10's center preview: the selected item drawn by the one renderer, at the service's resolved output
// profile, with the safe area dashed over it and every readiness finding written out in words. The target
// selector re-prepares for another output type and does nothing else — no request leaves for it beyond
// the reads the item itself needs, and nothing about the service changes.

import type { ReadinessCode } from '@holydeck/renderer/readiness';
import { renderForSurface } from '@holydeck/renderer/surfaces';
import type { MessageKey } from '@holydeck/localization/messages';
import type { JSX } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

import { t } from '../i18n.js';
import { saveState, service } from '../state/workspace-store.js';
import { findItem } from '../workspace/service-data.js';
import { FramePaint } from './FramePaint.js';
import { placeholderRatio, PREVIEW_TARGETS, usePreview, type PreviewTarget } from './preview-model.js';
import { SafeAreaOverlay } from './SafeAreaOverlay.js';

/** The editor pane width to scale into when the pane cannot be measured (tests, a hidden region). */
const FALLBACK_PANE_WIDTH_PX = 640;

const TARGET_KEYS: Readonly<Record<PreviewTarget, MessageKey>> = {
  audience: 'preview.target.audience',
  stage: 'preview.target.stage',
  singer: 'preview.target.singer',
};

const FINDING_KEYS: Readonly<Record<ReadinessCode, MessageKey>> = {
  'text.belowMinimumReadableSize': 'preview.finding.text.belowMinimumReadableSize',
  'text.overflowsAtMinimumReadableSize': 'preview.finding.text.overflowsAtMinimumReadableSize',
  'content.outsideSafeArea': 'preview.finding.content.outsideSafeArea',
  'decoration.outsideSafeArea': 'preview.finding.decoration.outsideSafeArea',
  'layout.ratioMismatch': 'preview.finding.layout.ratioMismatch',
  'media.volumeAboveBound': 'preview.finding.media.volumeAboveBound',
  'media.volumeBelowSilence': 'preview.finding.media.volumeBelowSilence',
};

/** The pane's own width, read once it is laid out; a zero-width (hidden) pane keeps the fallback. */
function usePaneWidth(): [preact.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(FALLBACK_PANE_WIDTH_PX);
  useLayoutEffect(() => {
    const measured = ref.current?.clientWidth ?? 0;
    if (measured > 0) setWidth(measured);
  }, []);
  return [ref, width];
}

function TargetSelector({ target, onChange }: { readonly target: PreviewTarget; readonly onChange: (next: PreviewTarget) => void }): JSX.Element {
  return (
    <fieldset class="preview-targets">
      <legend>{t('preview.target')}</legend>
      {PREVIEW_TARGETS.map((option) => (
        <label key={option} class="preview-target">
          <input
            type="radio" name="preview-target" value={option} checked={target === option}
            onChange={() => onChange(option)}
          />
          {t(TARGET_KEYS[option])}
        </label>
      ))}
    </fieldset>
  );
}

export interface ExactPreviewProps {
  readonly itemId: string;
}

export function ExactPreview({ itemId }: ExactPreviewProps): JSX.Element | null {
  const [target, setTarget] = useState<PreviewTarget>('audience');
  const { state, retry } = usePreview(itemId, target);
  const [paneRef, paneWidth] = usePaneWidth();

  const view = service.value;
  const item = view === undefined ? undefined : findItem(view, itemId);
  if (item === undefined) return null;
  const label = t('preview.label', { title: item.title });
  const offline = saveState.value === 'offline';

  let body: JSX.Element;
  if (state.status === 'later') {
    body = <p>{t('preview.later')}</p>;
  } else if (state.status === 'error') {
    body = (
      <div role="alert" class="preview-error">
        <p>{t('preview.error')}</p>
        <button type="button" onClick={retry} disabled={offline}>{t('preview.retry')}</button>
        <details>
          <summary>{t('preview.error.details')}</summary>
          <code>{state.code}</code>
        </details>
      </div>
    );
  } else if (state.status === 'loading') {
    body = (
      <div class="preview-skeleton" aria-busy="true" style={{ aspectRatio: placeholderRatio(view) }}>
        <p role="status">{t('preview.loading')}</p>
      </div>
    );
  } else {
    const render = renderForSurface('editor-preview', state.prepared, { viewportWidthPx: paneWidth });
    body = (
      <>
        <div class="preview-stage" style={{ position: 'relative', width: `${render.paint.widthPx}px`, height: `${render.paint.heightPx}px` }}>
          <FramePaint render={render} mediaOf={state.mediaOf} label={label} />
          <SafeAreaOverlay frame={render.frame} scale={render.paint.scale} />
        </div>
        {render.frame.findings.length === 0 ? null : (
          <ul class="preview-findings">
            {render.frame.findings.map((finding, index) => (
              <li key={`${finding.code}-${finding.boxId ?? ''}-${index}`} class={finding.severity === 'blocker' ? 'preview-finding-blocker' : 'preview-finding-warning'}>
                <strong>{t(finding.severity === 'blocker' ? 'preview.blocks' : 'preview.warns')}</strong>{' '}
                {t(FINDING_KEYS[finding.code])}
              </li>
            ))}
          </ul>
        )}
      </>
    );
  }

  return (
    <div class="exact-preview" ref={paneRef}>
      <TargetSelector target={target} onChange={setTarget} />
      {body}
    </div>
  );
}
