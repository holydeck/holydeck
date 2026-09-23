// The Slide Layout a song's slides are generated with, and the one button that generates them (P-6). A
// generation pins the exact song and Layout revisions it drew from, so the Layout's newest revision is read
// at the moment of generating rather than assumed; a song that already has a generated group regenerates
// that group, so every service that pins it sees the change as drift instead of a second copy.

import { isRecord } from '@holydeck/contracts/problems';
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';

import { API } from '../api-routes.js';
import { can, csrf } from '../app-state.js';
import { t } from '../i18n.js';
import { request } from '../request.js';
import { readSlideGroup, useSlideLayouts, type SlideGroupRecord } from '../workspace/tabs/song-sources.js';

export interface LayoutPickerProps {
  readonly id: string;
  readonly value: string;
  readonly onChange: (layoutId: string) => void;
}

/** The Slide Layouts to generate with; the first is chosen until the person picks another. */
export function LayoutPicker({ id, value, onChange }: LayoutPickerProps): JSX.Element {
  const layouts = useSlideLayouts();
  if (layouts.status === 'loading') return <p role="status">{t('app.loading')}</p>;
  if (layouts.status === 'error') return <p role="alert">{t('add.error')} <code>{layouts.code}</code></p>;
  if (layouts.value.length === 0) return <p>{t('song.layout.none')}</p>;
  return (
    <p>
      <label for={id}>{t('song.layout')}</label>
      <select id={id} value={value || layouts.value[0]?.id} onChange={(event) => onChange(event.currentTarget.value)}>
        {layouts.value.map((layout) => <option key={layout.id} value={layout.id}>{layout.name}</option>)}
      </select>
    </p>
  );
}

export interface GenerateSlidesProps {
  readonly songId: string;
  readonly songRevision: number;
  /** The group this song already generated, which is regenerated in place. */
  readonly groupId?: string;
  readonly onGenerated: (group: SlideGroupRecord) => void;
}

/** Picks a Layout and generates the song's slides from its current revision. */
export function GenerateSlides({ songId, songRevision, groupId, onGenerated }: GenerateSlidesProps): JSX.Element {
  const [layoutId, setLayoutId] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const layouts = useSlideLayouts();
  const chosen = layoutId || (layouts.status === 'ready' ? layouts.value[0]?.id ?? '' : '');

  const generate = async (): Promise<void> => {
    setBusy(true);
    setRefusal(undefined);
    const layout = await request(API.slideLayout(chosen));
    const layoutRevision = layout.ok && isRecord(layout.data) ? layout.data['revision'] : undefined;
    if (typeof layoutRevision !== 'number') {
      setRefusal(layout.ok ? 'client.unreadable_response' : layout.code);
      setBusy(false);
      return;
    }
    const answer = await request(API.songSlides(songId), {
      method: 'POST', csrf: csrf() ?? '',
      body: { songRevision, slideLayoutId: chosen, slideLayoutRevision: layoutRevision, ...(groupId === undefined ? {} : { slideGroupId: groupId }) },
    });
    const group = answer.ok ? readSlideGroup(answer.data) : undefined;
    if (group === undefined) setRefusal(answer.ok ? 'client.unreadable_response' : answer.code);
    else onGenerated(group);
    setBusy(false);
  };

  return (
    <div class="generate-slides">
      <LayoutPicker id={`generate-layout-${songId}`} value={chosen} onChange={setLayoutId} />
      <button type="button" disabled={chosen === '' || busy || !can('content.edit')} onClick={() => void generate()}>
        {t('song.generate')}
      </button>
      {refusal === undefined ? null : <p role="alert">{t('add.error')} <code>{refusal}</code></p>}
    </div>
  );
}
