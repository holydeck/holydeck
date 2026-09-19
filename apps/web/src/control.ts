// The operator control surface (LIVE-07): Order, Editor/Preview, Properties, and Live Controls. Each
// is a landmark `index.html` already declares with its own accessible name (AX-F2, raised at the
// DISC-02 accessibility measurement against a prototype whose six navigation links all resolved to one
// shared target) — this module only fills those landmarks with state and wires the input a live
// operator actually uses: clicking an order item, the Previous/Next transport, and the T52 shortcut
// catalogue's ten number keys. Every boundary and shortcut rule is `control-state.ts`'s, reused here
// rather than recomputed.
//
// `data` starts empty in production — no order-reading route exists yet, only T52 and T82 do, which is
// all this task depends on — so every element below renders its honest empty state instead of assuming
// data that has not been wired yet.
//
// Output-surface launching (`output-launch.ts`) is deliberately not wired into Live Controls: its own
// header scopes screen placement and arrangement to a separate task (LIVE-16), and nothing in this
// task's brief asks for it here.

import type { SlideLabelEntry } from '@holydeck/contracts/slide-labels';
import type { Locale } from '@holydeck/localization/locales';
import { translate } from '@holydeck/localization/messages';

import { indexForShortcut, isShortcutKey, previewPositions, type OrderItem } from './control-state.js';

/** The operator's current order and the live shortcut catalogue it is read against. */
export interface ControlData {
  readonly items: readonly OrderItem[];
  readonly catalogue: readonly SlideLabelEntry[];
}

/** One shape used for every element this module touches, real or faked, the same way `shell.ts` uses
 *  one shape for the element it touches — every field here is a real, standard property or method on
 *  any DOM element, so a real `document` satisfies this without this module ever importing a DOM lib
 *  (this workspace's `lib` is ES2023 only). */
export interface ElementLike {
  textContent: string | null;
  hidden: boolean;
  disabled: boolean;
  onclick: (() => void) | null;
  appendChild(child: ElementLike): void;
  replaceChildren(...nodes: readonly ElementLike[]): void;
}

export interface ControlDocumentLike {
  getElementById(id: string): ElementLike | null;
  createElement(tag: string): ElementLike;
  addEventListener(type: 'keydown', listener: (event: { readonly key: string }) => void): void;
}

const need = (doc: ControlDocumentLike, id: string): ElementLike => {
  const element = doc.getElementById(id);
  if (element === null) throw new Error(`the control surface is missing #${id}`);
  return element;
};

/**
 * Wires the four LIVE-07 regions onto live state. `selected` always names a real position once `data`
 * has at least one item — there is no separate "nothing selected yet" state once the order is non-empty,
 * the same way `previewPositions` never returns "nothing" for a non-empty order: an operator is always
 * somewhere in the order, and this starts them at its first item.
 */
export function renderControl(doc: ControlDocumentLike, locale: Locale, data: ControlData): void {
  const elements = {
    skipLinksHeading: need(doc, 'skip-links-heading'),
    skipOrder: need(doc, 'skip-order'),
    skipEditorPreview: need(doc, 'skip-editor-preview'),
    skipProperties: need(doc, 'skip-properties'),
    skipLiveControls: need(doc, 'skip-live-controls'),
    orderHeading: need(doc, 'order-heading'),
    orderEmpty: need(doc, 'order-empty'),
    orderList: need(doc, 'order-list'),
    editorPreviewHeading: need(doc, 'editor-preview-heading'),
    editorHeading: need(doc, 'editor-heading'),
    editorBody: need(doc, 'editor-body'),
    previewHeading: need(doc, 'preview-heading'),
    previewEmpty: need(doc, 'preview-empty'),
    previewRow: need(doc, 'preview-row'),
    previewCurrentLabel: need(doc, 'preview-current-label'),
    previewCurrent: need(doc, 'preview-current'),
    previewNextLabel: need(doc, 'preview-next-label'),
    previewNext: need(doc, 'preview-next'),
    propertiesHeading: need(doc, 'properties-heading'),
    propertiesEmpty: need(doc, 'properties-empty'),
    propertiesRow: need(doc, 'properties-row'),
    propertiesLabelHeading: need(doc, 'properties-label-heading'),
    propertiesValue: need(doc, 'properties-value'),
    liveControlsHeading: need(doc, 'live-controls-heading'),
    livePrevious: need(doc, 'live-previous'),
    liveNext: need(doc, 'live-next'),
    liveStatus: need(doc, 'live-status'),
  };

  elements.skipLinksHeading.textContent = translate(locale, 'control.skipLinks.label');
  elements.skipOrder.textContent = translate(locale, 'control.skip.order');
  elements.skipEditorPreview.textContent = translate(locale, 'control.skip.editorPreview');
  elements.skipProperties.textContent = translate(locale, 'control.skip.properties');
  elements.skipLiveControls.textContent = translate(locale, 'control.skip.liveControls');
  elements.orderHeading.textContent = translate(locale, 'control.region.order');
  elements.editorPreviewHeading.textContent = translate(locale, 'control.region.editorPreview');
  elements.propertiesHeading.textContent = translate(locale, 'control.region.properties');
  elements.liveControlsHeading.textContent = translate(locale, 'control.region.liveControls');
  elements.orderEmpty.textContent = translate(locale, 'control.order.empty');
  elements.editorHeading.textContent = translate(locale, 'control.editor.heading');
  elements.previewHeading.textContent = translate(locale, 'control.preview.heading');
  elements.previewEmpty.textContent = translate(locale, 'control.preview.empty');
  elements.previewCurrentLabel.textContent = translate(locale, 'control.preview.current');
  elements.previewNextLabel.textContent = translate(locale, 'control.preview.next');
  elements.propertiesEmpty.textContent = translate(locale, 'control.properties.empty');
  elements.propertiesLabelHeading.textContent = translate(locale, 'control.properties.label');
  elements.livePrevious.textContent = translate(locale, 'control.live.previous');
  elements.liveNext.textContent = translate(locale, 'control.live.next');

  let selected = 0;

  function renderPreview(): void {
    const positions = previewPositions(data.items.length, selected);
    // Clamped back onto `selected` itself: without this, a Next click at the last item (or a Previous
    // at the first) would still move the stored position past the edge even though nothing visible
    // changed, and the click needed to come back would silently stop matching the click that went out.
    if (positions.current !== undefined) selected = positions.current;
    const currentItem = positions.current === undefined ? undefined : data.items[positions.current];
    const nextItem = positions.next === undefined ? undefined : data.items[positions.next];

    elements.previewEmpty.hidden = currentItem !== undefined;
    elements.previewRow.hidden = currentItem === undefined;
    elements.propertiesEmpty.hidden = currentItem !== undefined;
    elements.propertiesRow.hidden = currentItem === undefined;

    if (currentItem === undefined) {
      elements.editorBody.textContent = translate(locale, 'control.editor.empty');
      elements.liveStatus.textContent = '';
    } else {
      elements.previewCurrent.textContent = currentItem.label;
      elements.previewNext.textContent =
        nextItem === undefined ? translate(locale, 'control.preview.noNext') : nextItem.label;
      elements.editorBody.textContent = currentItem.label;
      elements.propertiesValue.textContent = currentItem.label;
      elements.liveStatus.textContent = translate(locale, 'control.status.showing', { label: currentItem.label });
    }

    elements.livePrevious.disabled = positions.current === undefined || positions.current <= 0;
    elements.liveNext.disabled = positions.next === undefined;
  }

  function select(index: number): void {
    selected = index;
    renderPreview();
  }

  function renderOrder(): void {
    if (data.items.length === 0) {
      elements.orderEmpty.hidden = false;
      elements.orderList.hidden = true;
      elements.orderList.replaceChildren();
      return;
    }
    elements.orderEmpty.hidden = true;
    elements.orderList.hidden = false;
    elements.orderList.replaceChildren(
      ...data.items.map((item, index) => {
        const row = doc.createElement('li');
        const button = doc.createElement('button');
        button.textContent = translate(locale, 'control.order.select', { label: item.label });
        button.onclick = () => select(index);
        row.appendChild(button);
        return row;
      }),
    );
  }

  elements.livePrevious.onclick = () => select(selected - 1);
  elements.liveNext.onclick = () => select(selected + 1);

  doc.addEventListener('keydown', (event) => {
    if (!isShortcutKey(event.key)) return;
    const index = indexForShortcut(data.items, data.catalogue, event.key);
    if (index !== undefined) select(index);
  });

  renderOrder();
  renderPreview();
}
