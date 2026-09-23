// The service workspace: three regions — Order, Editor, Details — always in this DOM order so focus and
// heading structure read the same regardless of which region a narrow viewport currently shows (WS-04).
// Below 1200px width a bottom tablist switches which one is visible; none of the three is ever unmounted,
// so a half-typed edit survives a tab switch, a wide/narrow relayout, and a reconnect after going offline
// (`useConnection` refreshes the service in the background rather than reloading the page). `WorkspaceFrame`
// only lays the regions out — later tasks plug the real Order, Editor and Library content into its slots
// without touching this file again.

import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';

import { joinAllowedFor } from '@holydeck/contracts/services';
import type { MessageKey } from '@holydeck/localization/messages';
import type { ComponentChildren, JSX } from 'preact';

import { CustomSlideCanvas } from '../editors/CustomSlideCanvas.js';
import { ReadingEditor } from '../editors/ReadingEditor.js';
import { SlideGroupEditor } from '../editors/SlideGroupEditor.js';
import { SongItemEditor } from '../editors/SongItemEditor.js';
import { t } from '../i18n.js';
import { ExactPreview } from '../preview/ExactPreview.js';
import {
  loadService, loadState, resetWorkspace, rightTab, selection, service,
} from '../state/workspace-store.js';
import { AddPanel } from './AddPanel.js';
import { LifecycleMenu } from './LifecycleMenu.js';
import { OrderPanel } from './OrderPanel.js';
import { PropertiesPanel } from './PropertiesPanel.js';
import { startPositionWriter } from './position-writer.js';
import { findItem } from './service-data.js';
import { useConnection } from './use-connection.js';
import { WorkspaceStatus } from './WorkspaceStatus.js';

const WIDE_QUERY = '(min-width: 1200px)';

function readWide(): boolean {
  try {
    return globalThis.matchMedia(WIDE_QUERY).matches;
  } catch {
    return false;
  }
}

/** Whether the viewport is wide enough to show Order, Editor and Details at once; reacts live so a window
 *  resize or a browser zoom change relayouts without a reload. */
function useWideLayout(): boolean {
  const [wide, setWide] = useState(readWide);
  useEffect(() => {
    let list: MediaQueryList;
    try {
      list = globalThis.matchMedia(WIDE_QUERY);
    } catch {
      return undefined;
    }
    const update = (): void => setWide(list.matches);
    try {
      list.addEventListener('change', update);
    } catch {
      // Some test doubles for matchMedia only support the initial read, not live updates.
    }
    return (): void => {
      try {
        list.removeEventListener('change', update);
      } catch {
        // See above.
      }
    };
  }, []);
  return wide;
}

type TabKeyEvent = JSX.TargetedKeyboardEvent<HTMLButtonElement>;

/** WAI-ARIA tab pattern keyboard support: arrows move and select, Home/End jump to the ends. */
function onTabKey(ids: readonly string[], index: number, choose: (next: number) => void): (event: TabKeyEvent) => void {
  return (event) => {
    const last = ids.length - 1;
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (index === last ? 0 : index + 1)
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (index === 0 ? last : index - 1)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? last
      : undefined;
    if (next === undefined) return;
    event.preventDefault();
    choose(next);
    document.getElementById(ids[next] ?? '')?.focus();
  };
}

type MobileRegion = 'order' | 'editor' | 'details';
type BottomRegion = 'order' | 'editor' | 'library' | 'properties';

// Which of the three regions a narrow viewport currently shows. Module-scoped (like `rightTab` in the
// store) rather than component state, so content outside `WorkspaceFrame` — the empty-order "Add Content"
// button below — can switch to Details too. `Workspace`'s mount effect resets it to 'order' per service.
const mobileRegion = signal<MobileRegion>('order');

const ORDER_REGION_ID = 'workspace-region-order';
const EDITOR_REGION_ID = 'workspace-region-editor';
const PROPERTIES_PANEL_ID = 'workspace-panel-properties';
const LIBRARY_PANEL_ID = 'workspace-panel-library';

const BOTTOM_TABS: readonly { readonly id: string; readonly region: BottomRegion; readonly key: MessageKey; readonly controls: string }[] = [
  { id: 'workspace-tab-order', region: 'order', key: 'workspace.region.order', controls: ORDER_REGION_ID },
  { id: 'workspace-tab-editor', region: 'editor', key: 'workspace.region.editor', controls: EDITOR_REGION_ID },
  { id: 'workspace-tab-library', region: 'library', key: 'workspace.tab.library', controls: LIBRARY_PANEL_ID },
  { id: 'workspace-tab-properties', region: 'properties', key: 'workspace.tab.properties', controls: PROPERTIES_PANEL_ID },
];
const BOTTOM_IDS = BOTTOM_TABS.map((tab) => tab.id);
const ASIDE_IDS = ['workspace-tab-properties-aside', 'workspace-tab-library-aside'];

function EditorPlaceholder(): JSX.Element {
  return <textarea aria-label={t('workspace.region.editor')} />;
}

/** The center region: the selected item's editor where it has one, above its exact preview; the bare
 *  editor until something is selected. Keyed by item, so switching items never carries an edit across. */
/** A song or slide group item: its song (for a song) or, behind `Edit Slides`, the slide group it pins. */
function GroupItemEditor({ itemId }: { readonly itemId: string }): JSX.Element {
  const [slides, setSlides] = useState(false);
  const view = service.value;
  const item = view === undefined ? undefined : findItem(view, itemId);
  const groupId = item?.content?.id;
  return (
    <>
      {groupId === undefined ? null : (
        <button type="button" aria-pressed={slides} onClick={() => setSlides(!slides)}>{t('slides.edit.open')}</button>
      )}
      {slides && groupId !== undefined ? <SlideGroupEditor groupId={groupId} />
        : item?.kind === 'song' ? <SongItemEditor itemId={itemId} /> : null}
    </>
  );
}

function EditorCenter(): JSX.Element {
  const itemId = selection.value.itemId;
  if (itemId === undefined) return <EditorPlaceholder />;
  const view = service.value;
  const kind = view === undefined ? undefined : findItem(view, itemId)?.kind;
  return (
    <>
      {kind === 'reading' ? <ReadingEditor key={itemId} itemId={itemId} /> : null}
      {kind === 'custom-slide' ? <CustomSlideCanvas key={itemId} itemId={itemId} /> : null}
      {kind === 'song' || kind === 'slide-group' ? <GroupItemEditor key={itemId} itemId={itemId} /> : null}
      <ExactPreview key={itemId} itemId={itemId} />
    </>
  );
}

type FrameSlots = {
  readonly order: ComponentChildren;
  readonly center: ComponentChildren;
  readonly properties: ComponentChildren;
  readonly library: ComponentChildren;
  readonly status: ComponentChildren;
};

/** Lays Order, Editor and Details out — a 3-column grid at 1200px+, one region at a time below it. */
function WorkspaceFrame({ order, center, properties, library, status }: FrameSlots): JSX.Element {
  const wide = useWideLayout();

  const bottomIndex = mobileRegion.value === 'order' ? 0 : mobileRegion.value === 'editor' ? 1
    : rightTab.value === 'library' ? 2 : 3;
  const chooseBottom = (index: number): void => {
    const tab = BOTTOM_TABS[index] ?? BOTTOM_TABS[0];
    if (tab === undefined) return;
    if (tab.region === 'order' || tab.region === 'editor') {
      mobileRegion.value = tab.region;
      return;
    }
    mobileRegion.value = 'details';
    rightTab.value = tab.region;
  };

  const asideIndex = rightTab.value === 'properties' ? 0 : 1;
  const chooseAside = (index: number): void => {
    rightTab.value = index === 0 ? 'properties' : 'library';
  };

  return (
    <>
      {status}
      <div class="service-workspace">
        <nav
          id={ORDER_REGION_ID} aria-label={t('workspace.region.order')} class="service-workspace-region"
          hidden={!(wide || mobileRegion.value === 'order')}
        >
          {order}
        </nav>
        <section
          id={EDITOR_REGION_ID} aria-label={t('workspace.region.editor')} class="service-workspace-region"
          hidden={!(wide || mobileRegion.value === 'editor')}
        >
          {center}
        </section>
        <aside aria-label={t('workspace.region.details')} class="service-workspace-region" hidden={!(wide || mobileRegion.value === 'details')}>
          {wide ? (
            <div role="tablist" aria-label={t('workspace.region.details')}>
              <button
                type="button" role="tab" id="workspace-tab-properties-aside"
                aria-selected={asideIndex === 0} aria-controls={PROPERTIES_PANEL_ID}
                tabIndex={asideIndex === 0 ? 0 : -1}
                onClick={() => chooseAside(0)}
                onKeyDown={onTabKey(ASIDE_IDS, asideIndex, chooseAside)}
              >
                {t('workspace.tab.properties')}
              </button>
              <button
                type="button" role="tab" id="workspace-tab-library-aside"
                aria-selected={asideIndex === 1} aria-controls={LIBRARY_PANEL_ID}
                tabIndex={asideIndex === 1 ? 0 : -1}
                onClick={() => chooseAside(1)}
                onKeyDown={onTabKey(ASIDE_IDS, asideIndex, chooseAside)}
              >
                {t('workspace.tab.library')}
              </button>
            </div>
          ) : null}
          <div
            id={PROPERTIES_PANEL_ID}
            role={wide ? 'tabpanel' : undefined}
            aria-labelledby={wide ? 'workspace-tab-properties-aside' : undefined}
            hidden={rightTab.value !== 'properties'}
          >
            {properties}
          </div>
          <div
            id={LIBRARY_PANEL_ID}
            role={wide ? 'tabpanel' : undefined}
            aria-labelledby={wide ? 'workspace-tab-library-aside' : undefined}
            hidden={rightTab.value !== 'library'}
          >
            {library}
          </div>
        </aside>
        {wide ? null : (
          <div role="tablist" aria-label={t('workspace.title')} class="service-workspace-tabs">
            {BOTTOM_TABS.map((tab, index) => (
              <button
                type="button" role="tab" id={tab.id} key={tab.id}
                aria-selected={bottomIndex === index} aria-controls={tab.controls}
                tabIndex={bottomIndex === index ? 0 : -1}
                onClick={() => chooseBottom(index)}
                onKeyDown={onTabKey(BOTTOM_IDS, bottomIndex, chooseBottom)}
              >
                {t(tab.key)}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/** The one page a workspace screen renders once a service is chosen. */
export function Workspace({ id }: { readonly id: string }): JSX.Element {
  useConnection(id);

  useEffect(() => {
    resetWorkspace();
    mobileRegion.value = 'order';
    void loadService(id);
    return (): void => resetWorkspace();
  }, [id]);

  useEffect(() => startPositionWriter(), []);

  useEffect(() => {
    if (loadState.value !== 'loaded') return;
    const current = service.value;
    if (current === undefined) return;
    const itemId = new URLSearchParams(globalThis.location?.search ?? '').get('item');
    if (itemId === null || findItem(current, itemId) === undefined) return;
    selection.value = { itemId };
    try {
      document.getElementById(`workspace-item-${itemId}`)?.scrollIntoView();
    } catch {
      // Not every test document implements scrolling; the restored selection is what matters.
    }
  }, [id, loadState.value]);

  const state = loadState.value;

  if (state === 'idle' || state === 'loading') {
    return (
      <div class="workspace-main" aria-busy="true">
        <h1 class="visually-hidden">{t('workspace.title')}</h1>
        <p role="status">{t('app.loading')}</p>
      </div>
    );
  }

  if (state === 'missing') {
    return (
      <div class="workspace-main">
        <h1 class="visually-hidden">{t('workspace.title')}</h1>
        <p role="alert">{t('workspace.missing')}</p>
        <p><a href="/services">{t('serviceNew.back')}</a></p>
      </div>
    );
  }

  const view = service.value;
  if (state === 'error' || view === undefined) {
    return (
      <div class="workspace-main">
        <h1 class="visually-hidden">{t('workspace.title')}</h1>
        <p role="alert">{t('workspace.load.error')}</p>
        <button type="button" onClick={() => void loadService(id)}>{t('workspace.load.retry')}</button>
      </div>
    );
  }

  return (
    <div class="workspace-main">
      <h1 class="visually-hidden">{view.title}</h1>
      <div class="workspace-header">
        <LifecycleMenu view={view} />
        {view.state === 'completed' || view.state === 'archived' ? <p role="note">{t('lifecycle.readOnly')}</p> : null}
        {joinAllowedFor(view.state) ? <p>{t('lifecycle.join')}</p> : null}
      </div>
      <WorkspaceFrame
        order={<OrderPanel view={view} onEmpty={() => { rightTab.value = 'library'; mobileRegion.value = 'details'; }} />}
        center={<EditorCenter />}
        properties={<PropertiesPanel />}
        library={<AddPanel />}
        status={<WorkspaceStatus />}
      />
    </div>
  );
}
