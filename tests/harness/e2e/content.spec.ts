// The content journey CRT-12 describes: an Admin administers the shared catalogues, then an Editor
// writes and generates from them. API-level through the signed-in session, the same way control.spec.ts
// proves the order route — not browser-UI-driven, because spec 03 owns the UI these routes are eventually
// driven through, and this spec's own routes have no page yet for a real navigation to reach.

import { ACCOUNTS_PATH } from '@holydeck/contracts/accounts';
import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { CONTENT_LANGUAGES_PATH } from '@holydeck/contracts/content-languages';
import { CSRF_HEADER } from '@holydeck/contracts/sessions';
import { SLIDE_LAYOUTS_PATH } from '@holydeck/contracts/layouts';
import { LIBRARY_PATH } from '@holydeck/contracts/library';
import { SCRIPTURE_SEARCH_PATH } from '@holydeck/contracts/scripture';
import { SLIDE_GROUPS_PATH } from '@holydeck/contracts/slide-groups';
import { SLIDE_LABELS_PATH } from '@holydeck/contracts/slide-labels';
import { SONGS_PATH } from '@holydeck/contracts/songs';
import { expect, test } from '@playwright/test';

import { signInAs, signInTo } from '../src/identity.js';

import type { SignedIn } from '../src/identity.js';

// `apps/app/src/media-routes.ts` names this the same literal, but `@holydeck/contracts` has no media
// path constant to import — the media library's routes are the one content surface this spec's Test
// Plan lists whose path never left the app package.
const MEDIA_PATH = '/api/v1/media';

const request = async (
  baseUrl: string,
  method: string,
  path: string,
  session: SignedIn,
  body?: unknown,
): Promise<Response> =>
  fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      origin: baseUrl,
      [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
      cookie: session.cookie,
      [CSRF_HEADER]: session.csrf,
      ...(body === undefined ? {} : { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json' }),
    },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });

test.describe('the content journey CRT-12 describes', () => {
  test('an Admin sets up the catalogues an Editor then writes, generates and searches against', async (
    { baseURL },
    testInfo,
  ) => {
    // One shared stack for the whole Playwright run (globalSetup, workers: 1) — every account, content
    // language and song this test creates would collide with itself on a second device-form-factor pass.
    test.skip(testInfo.project.name !== 'desktop', 'one shared stack; this journey runs once, not per form factor');
    const url = baseURL!;
    const admin = await signInTo(url);

    // Admin: the two catalogues CATALOGUE_MANAGE administers.
    const language = await request(url, 'POST', CONTENT_LANGUAGES_PATH, admin, {
      key: 'jrn', displayName: 'Journey', script: 'Latin', fallbackFont: 'sans-serif',
    });
    expect(language.status).toBe(201);

    const label = await request(url, 'POST', SLIDE_LABELS_PATH, admin, { name: 'Journey label' });
    expect(label.status).toBe(201);

    // Admin: a Slide Layout with one statically-bound box, so generation resolves without depending on
    // matching any particular song content shape (the same simplification song-routes.test.ts's own
    // "generates slides" test relies on).
    const layoutCreated = await request(url, 'POST', SLIDE_LAYOUTS_PATH, admin, {
      name: 'Journey layout',
      boxes: [{
        id: 'static', kind: 'text', importance: 'required', frame: { x: 0, y: 0, width: 1, height: 1 },
        binding: { mode: 'static', text: 'Sunday' },
        style: { fontFamily: 'Inter', fontWeight: 400, sizeRatio: 0.1, lineHeight: 1, align: 'start', verticalAlign: 'start' },
      }],
    });
    expect(layoutCreated.status).toBe(201);
    const layout = (await layoutCreated.json()) as { data: { stamp: { id: string }; revision: number } };

    // Admin: an Editor account, so the rest of the journey runs under content.edit rather than an Admin's
    // wider reach.
    const editorName = 'journey-editor';
    const editorPassword = 'a-long-enough-passphrase-too';
    const accountCreated = await request(url, 'POST', ACCOUNTS_PATH, admin, {
      name: editorName, displayName: 'Journey Editor', password: editorPassword, role: 'editor',
    });
    expect(accountCreated.status).toBe(201);
    const editor = await signInAs(url, { name: editorName, password: editorPassword });

    // Editor: creates a song.
    const songCreated = await request(url, 'POST', SONGS_PATH, editor, {
      title: 'Journey song',
      body: {
        titles: { tamil: 'பயணம்', romanized: 'Payanam' },
        languages: ['ta'],
        sections: [{ id: 'verse-1', label: 'Verse 1', text: [{ languageKey: 'ta', text: 'வரிகள்' }] }],
        provenance: { source: 'manual' },
      },
    });
    expect(songCreated.status).toBe(201);
    const song = (await songCreated.json()) as { data: { stamp: { id: string }; revision: number } };
    const songPath = `${SONGS_PATH}/${song.data.stamp.id}`;

    // Editor: edits the song's raw YAML — round-tripped unchanged, which is enough to prove the route.
    const rawRead = await request(url, 'GET', `${songPath}/raw`, editor);
    expect(rawRead.status).toBe(200);
    const rawText = await rawRead.text();
    const rawEdited = await request(url, 'PUT', `${songPath}/raw`, editor, rawText);
    expect(rawEdited.status).toBe(200);
    const editedSong = (await rawEdited.json()) as { data: { revision: number } };

    // Editor: lists Slide Layouts, then generates slides against the one Admin created.
    const layouts = await request(url, 'GET', SLIDE_LAYOUTS_PATH, editor);
    expect(layouts.status).toBe(200);

    const generated = await request(url, 'POST', `${songPath}/slides`, editor, {
      songRevision: editedSong.data.revision, slideLayoutId: layout.data.stamp.id, slideLayoutRevision: layout.data.revision,
    });
    expect(generated.status).toBe(200);
    const group = (await generated.json()) as {
      data: { stamp: { id: string }; body: { slides: ReadonlyArray<{ id: string }> } };
    };
    expect(group.data.body.slides.length).toBeGreaterThan(0);

    // Editor: disables one slide.
    const slideId = group.data.body.slides[0]!.id;
    const disabled = await request(
      url, 'PATCH', `${SLIDE_GROUPS_PATH}/${group.data.stamp.id}/slides/${slideId}`, editor, { enabled: false },
    );
    expect(disabled.status).toBe(200);

    // Editor: searches scripture. Nothing is synced into this harness's corpus — its own MongoDB starts
    // empty (tests/harness/src/mongo.ts), and a real sync needs a live upstream this run never reaches —
    // and `@holydeck/corpus` exposes no library entry point (no `exports` map at all) to seed verse text
    // directly the way the corpus package's own tests do. So what is proved here is the route's shape and
    // status against an honestly-empty corpus, not a seeded-word hit; seeding one is a package-boundary
    // change outside this spec's own six content-route files.
    const search = await request(url, 'GET', `${SCRIPTURE_SEARCH_PATH}?q=grace`, editor);
    expect(search.status).toBe(200);
    const found = (await search.json()) as { data: readonly unknown[] };
    expect(found.data).toEqual([]);

    // Editor: lists the library and the media store.
    const library = await request(url, 'GET', LIBRARY_PATH, editor);
    expect(library.status).toBe(200);
    const media = await request(url, 'GET', MEDIA_PATH, editor);
    expect(media.status).toBe(200);
  });
});
