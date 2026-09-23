// The center editor for a song item already in the service (WS-09). A song item pins a generated slide
// group, not the song, so the song to edit is found through that group's `generatedFrom.songId`. Editing
// changes the song only; the item keeps its pinned group until slides are generated again and the
// Properties panel's Update moves it onto them (ADR 0005).

import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { API } from '../api-routes.js';
import { t } from '../i18n.js';
import { request } from '../request.js';
import { service } from '../state/workspace-store.js';
import { findItem } from '../workspace/service-data.js';
import { readSlideGroup } from '../workspace/tabs/song-sources.js';
import { SongEditor } from './SongEditor.js';

type Found = { readonly state: 'loading' } | { readonly state: 'missing' } | { readonly state: 'ready'; readonly songId: string };

/** The song id a slide group was generated from, or undefined when it was not generated from one. */
export async function songOfGroup(groupId: string): Promise<string | undefined> {
  const answer = await request(API.slideGroup(groupId));
  const songId = answer.ok ? readSlideGroup(answer.data)?.body.generatedFrom?.['songId'] : undefined;
  return typeof songId === 'string' ? songId : undefined;
}

/** Edits the song behind one song item. */
export function SongItemEditor({ itemId }: { readonly itemId: string }): JSX.Element {
  const view = service.value;
  const groupId = view === undefined ? undefined : findItem(view, itemId)?.content?.id;
  const [found, setFound] = useState<Found>({ state: 'loading' });

  useEffect(() => {
    let current = true;
    setFound({ state: 'loading' });
    void (async (): Promise<void> => {
      const songId = groupId === undefined ? undefined : await songOfGroup(groupId);
      if (current) setFound(songId === undefined ? { state: 'missing' } : { state: 'ready', songId });
    })();
    return () => { current = false; };
  }, [groupId]);

  if (found.state === 'loading') return <p>{t('app.loading')}</p>;
  if (found.state === 'missing') return <p role="alert">{t('song.missing')}</p>;
  return <SongEditor songId={found.songId} />;
}
