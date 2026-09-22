// The operator workspace (LIVE-07) stays in one declarative tree: four named panel targets for small
// screens, the transport that moves through an order, and the shortcut catalogue that can jump directly
// to a labelled item. Fragments remain ordinary document navigation so the CSS target rules retain their
// accessible panel behaviour without router involvement.

import { useEffect, useState } from 'preact/hooks';

import { indexForShortcut, isShortcutKey, previewPositions } from '../control-state.js';
import { t } from '../i18n.js';

import type { ControlData } from './order-data.js';
import type { JSX } from 'preact';

export type { ControlData } from './order-data.js';

/** The parsed order, service identity and route-owned live status the workspace displays. */
export interface OrderViewProps {
  readonly data: ControlData;
  readonly serviceId: string;
  /** The service route owns the socket; its current localized status belongs in this fixed region. */
  readonly connectionStatus?: string;
}

/** Renders one service's order, selection preview and live transport controls. */
export function OrderView({ data, serviceId, connectionStatus = '' }: OrderViewProps): JSX.Element {
  const [selected, setSelected] = useState(0);
  const positions = previewPositions(data.items.length, selected);
  const current = positions.current === undefined ? undefined : data.items[positions.current];
  const next = positions.next === undefined ? undefined : data.items[positions.next];

  useEffect(() => {
    // A deep link such as `/services/<id>#live-controls` is resolved before this view exists, and a
    // browser only settles `:target` when it navigates. Replaying the same fragment once the panels are
    // rendered lets the small-screen panel rules show the one the address names, without a history entry.
    const { hash, pathname, search } = location;
    if (hash === '' || document.getElementById(decodeURIComponent(hash.slice(1))) === null) return;
    history.replaceState(history.state, '', `${pathname}${search}`);
    location.replace(hash);
  }, []);

  useEffect(() => {
    const selectShortcut = (event: KeyboardEvent): void => {
      if (!isShortcutKey(event.key)) return;
      const index = indexForShortcut(data.items, data.catalogue, event.key);
      if (index !== undefined) setSelected(index);
    };
    document.addEventListener('keydown', selectShortcut);
    return () => document.removeEventListener('keydown', selectShortcut);
  }, [data]);

  const select = (index: number): void => {
    const nextPositions = previewPositions(data.items.length, index);
    if (nextPositions.current !== undefined) setSelected(nextPositions.current);
  };

  return (
    <>
      <h1 class="visually-hidden">{t('app.service.title', { id: serviceId })}</h1>
      <p class="service-id">{serviceId}</p>
      <nav class="skip-links" aria-labelledby="skip-links-heading">
        <h2 id="skip-links-heading" class="visually-hidden">{t('control.skipLinks.label')}</h2>
        <ul>
          <li><a class="skip-link" id="skip-order" href="#order">{t('control.skip.order')}</a></li>
          <li><a class="skip-link" id="skip-editor-preview" href="#editor-preview">{t('control.skip.editorPreview')}</a></li>
          <li><a class="skip-link" id="skip-properties" href="#properties">{t('control.skip.properties')}</a></li>
          <li><a class="skip-link" id="skip-live-controls" href="#live-controls">{t('control.skip.liveControls')}</a></li>
        </ul>
      </nav>
      <div class="workspace">
        <section id="order" class="workspace-panel" tabindex={-1} aria-labelledby="order-heading">
          <h2 id="order-heading">{t('control.region.order')}</h2>
          <p id="order-empty" hidden={data.items.length !== 0}>{t('control.order.empty')}</p>
          <ul id="order-list" hidden={data.items.length === 0}>
            {data.items.map((item, index) => (
              <li key={item.id}>
                <button type="button" onClick={() => select(index)}>{t('control.order.select', { label: item.label })}</button>
              </li>
            ))}
          </ul>
        </section>
        <section id="editor-preview" class="workspace-panel" tabindex={-1} aria-labelledby="editor-preview-heading">
          <h2 id="editor-preview-heading">{t('control.region.editorPreview')}</h2>
          <div>
            <h3 id="editor-heading">{t('control.editor.heading')}</h3>
            <p id="editor-body">{current?.label ?? t('control.editor.empty')}</p>
          </div>
          <section id="live-controls" tabindex={-1} aria-labelledby="live-controls-heading">
            <h2 id="live-controls-heading">{t('control.region.liveControls')}</h2>
            <p id="connection-status">{connectionStatus}</p>
            <h3 id="preview-heading">{t('control.preview.heading')}</h3>
            <p id="preview-empty" hidden={current !== undefined}>{t('control.preview.empty')}</p>
            <p id="preview-row" hidden={current === undefined}>
              <span><span id="preview-current-label">{t('control.preview.current')}</span>: <span id="preview-current">{current?.label}</span></span>
              <span><span id="preview-next-label">{t('control.preview.next')}</span>: <span id="preview-next">{next?.label ?? t('control.preview.noNext')}</span></span>
            </p>
            <div class="live-actions">
              <button id="live-previous" type="button" disabled={positions.current === undefined || positions.current <= 0} onClick={() => select(selected - 1)}>{t('control.live.previous')}</button>
              <button id="live-next" type="button" disabled={positions.next === undefined} onClick={() => select(selected + 1)}>{t('control.live.next')}</button>
            </div>
            <p id="live-status" aria-live="polite">{current === undefined ? '' : t('control.status.showing', { label: current.label })}</p>
          </section>
        </section>
        <section id="properties" class="workspace-panel" tabindex={-1} aria-labelledby="properties-heading">
          <h2 id="properties-heading">{t('control.region.properties')}</h2>
          <p id="properties-empty" hidden={current !== undefined}>{t('control.properties.empty')}</p>
          <p id="properties-row" hidden={current === undefined}>
            <span id="properties-label-heading">{t('control.properties.label')}</span>: <span id="properties-value">{current?.label}</span>
          </p>
        </section>
        <section id="library" class="workspace-panel" tabindex={-1} aria-labelledby="library-heading">
          <h2 id="library-heading">{t('control.region.library')}</h2>
        </section>
      </div>
      <nav class="workspace-tabs" aria-label={t('control.tabs.label')}>
        <a href="#order">{t('control.tabs.order')}</a>
        <a href="#editor-preview">{t('control.tabs.editor')}</a>
        <a href="#library">{t('control.tabs.library')}</a>
        <a href="#properties">{t('control.tabs.properties')}</a>
      </nav>
    </>
  );
}
