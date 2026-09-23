// The small picture under an expanded order row. It prepares exactly what `ExactPreview` prepares — the same
// `prepareRenderModel` input, only painted through `renderThumbnail` — so the two can never disagree about a
// line break. A long service expands many rows at once, so nothing is fetched until the row actually scrolls
// into view; where there is no `IntersectionObserver` (happy-dom, very old browsers) it prepares at once.

import { renderThumbnail } from '@holydeck/renderer/surfaces';
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import { t } from '../i18n.js';
import { service } from '../state/workspace-store.js';
import { findItem } from '../workspace/service-data.js';
import { FramePaint } from './FramePaint.js';
import { placeholderRatio, usePreview } from './preview-model.js';

/** The painted width of every thumbnail, in CSS pixels. */
export const THUMBNAIL_WIDTH_PX = 240;

/** Whether the element has come into view yet; true at once where the browser cannot tell. */
function useSeen(): [preact.RefObject<HTMLDivElement>, boolean] {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const element = ref.current;
    if (seen || element === null || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setSeen(true);
        observer.disconnect();
      }
    });
    observer.observe(element);
    return (): void => observer.disconnect();
  }, [seen]);
  return [ref, seen];
}

export interface ThumbnailProps {
  readonly itemId: string;
}

/** One item's first slide at thumbnail size, or a same-sized placeholder until it is drawn. */
export function Thumbnail({ itemId }: ThumbnailProps): JSX.Element {
  const [ref, seen] = useSeen();
  const { state } = usePreview(itemId, 'audience', seen);
  const view = service.value;
  const title = (view === undefined ? undefined : findItem(view, itemId))?.title ?? '';

  if (state.status === 'ready') {
    const render = renderThumbnail(state.prepared, { widthPx: THUMBNAIL_WIDTH_PX });
    return (
      <div class="thumbnail" ref={ref}>
        <FramePaint render={render} mediaOf={state.mediaOf} label={t('preview.label', { title })} />
      </div>
    );
  }
  return (
    <div
      class="thumbnail thumbnail-placeholder" ref={ref} aria-hidden="true"
      style={{ width: `${THUMBNAIL_WIDTH_PX}px`, aspectRatio: placeholderRatio(view) }}
    />
  );
}
