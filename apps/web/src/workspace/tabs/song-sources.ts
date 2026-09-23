// The song reads the Song tab and the Song editor share: the songs to pick from, one song at a revision,
// the languages, labels and layouts a song is written against, and — because a song enters a service as
// the slide group generated from it (P-6) — that group and the exact revision reference an item pins.
// Every reader parses what arrived and answers a value or the refusal code to show, never a half-read shape.

import { isRecord, type Parsed } from '@holydeck/contracts/problems';
import { revisionAddress, revisionBytes } from '@holydeck/contracts/revisions';
import type { RevisionRef } from '@holydeck/contracts/services';
import { parseSlideGroupBody, type SlideGroupBody } from '@holydeck/contracts/slide-groups';
import { parseSongBody, type SongBody } from '@holydeck/contracts/songs';

import { UNREADABLE_RESPONSE } from '../../api.js';
import { API } from '../../api-routes.js';
import { request } from '../../request.js';
import { useSource, type Loaded } from './bible-sources.js';

/** A library entry as a list shows it. */
export type Titled = { readonly id: string; readonly title: string };

/** One song at one revision, as the editor holds it. */
export type SongRecord = { readonly id: string; readonly title: string; readonly revision: number; readonly body: SongBody };

/** A slide group as the Song tab previews and pins it. */
export type SlideGroupRecord = { readonly id: string; readonly title: string; readonly updatedAt: string; readonly body: SlideGroupBody };

/** A language a song can be written in, and the name to show for it. */
export type LanguageChoice = { readonly key: string; readonly name: string };

/** A Slide Layout to generate with, and the name to show for it. */
export type LayoutChoice = { readonly id: string; readonly name: string };

const fail = (path: string): Parsed<never> => ({ ok: false, problems: [{ path, code: UNREADABLE_RESPONSE, message: 'unreadable' }] });

const stampOf = (value: unknown): Record<string, unknown> | undefined =>
  isRecord(value) && isRecord(value['stamp']) ? value['stamp'] : undefined;

const text = (value: unknown, key: string): string | undefined =>
  isRecord(value) && typeof value[key] === 'string' ? value[key] : undefined;

/** A list of `{stamp, <name>}` records as id and name. */
const listOf = (nameKey: string) => (data: unknown): Parsed<readonly Titled[]> => {
  if (!Array.isArray(data)) return fail('list');
  const rows: Titled[] = [];
  for (const entry of data) {
    const id = text(stampOf(entry), 'id');
    const title = text(entry, nameKey);
    if (id === undefined || title === undefined) return fail('list');
    rows.push({ id, title });
  }
  return { ok: true, value: rows };
};

/** Library rows (`{stamp, title}`) as id and title. */
export const readTitled = listOf('title');

/** A song answer (`{stamp, title, revision, body}`), or undefined when it is not one. */
export function readSongRecord(data: unknown): SongRecord | undefined {
  const id = text(stampOf(data), 'id');
  const title = text(data, 'title');
  const revision = isRecord(data) ? data['revision'] : undefined;
  const body = parseSongBody(isRecord(data) ? data['body'] : undefined);
  if (id === undefined || title === undefined || typeof revision !== 'number' || !body.ok) return undefined;
  return { id, title, revision, body: body.value };
}

/** A slide group answer (`{stamp, title, body}`), or undefined when it is not one. */
export function readSlideGroup(data: unknown): SlideGroupRecord | undefined {
  const stamp = stampOf(data);
  const id = text(stamp, 'id');
  const title = text(data, 'title');
  const body = parseSlideGroupBody(isRecord(data) ? data['body'] : undefined, 'slideGroup');
  if (id === undefined || title === undefined || !body.ok) return undefined;
  return { id, title, updatedAt: text(stamp, 'updatedAt') ?? '', body: body.value };
}

/** The songs whose title matches `q`. */
export function useSongs(q: string): [Loaded<readonly Titled[]>, () => void] {
  const needle = q.trim();
  return useSource(API.library({ kind: 'song', ...(needle === '' ? {} : { q: needle }) }), readTitled);
}

/** The content languages offered where a language is chosen. */
export function useContentLanguages(): Loaded<readonly LanguageChoice[]> {
  const [loaded] = useSource(API.contentLanguages, (data): Parsed<readonly LanguageChoice[]> => {
    if (!Array.isArray(data)) return fail('languages');
    const rows = data.flatMap((entry) => {
      const key = text(entry, 'key');
      return key === undefined ? [] : [{ key, name: text(entry, 'displayName') ?? key }];
    });
    return { ok: true, value: rows };
  });
  return loaded;
}

/** The slide label names offered for a section's label. */
export function useSlideLabels(): readonly string[] {
  const [loaded] = useSource(API.slideLabels, listOf('name'));
  return loaded.status === 'ready' ? loaded.value.map((row) => row.title) : [];
}

/** The Slide Layouts a song can be generated with. */
export function useSlideLayouts(): Loaded<readonly LayoutChoice[]> {
  const [loaded] = useSource(API.slideLayouts(), (data): Parsed<readonly LayoutChoice[]> => {
    const rows = listOf('name')(data);
    return rows.ok ? { ok: true, value: rows.value.map((row) => ({ id: row.id, name: row.title })) } : rows;
  });
  return loaded;
}

const hexOf = (digest: ArrayBuffer): string =>
  Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');

/** The address the server gives a body (ADR 0001), or undefined where this browser cannot hash. */
export async function addressOf(body: unknown): Promise<string | undefined> {
  try {
    const bytes = new TextEncoder().encode(revisionBytes(body as Readonly<Record<string, unknown>>));
    return revisionAddress(hexOf(await globalThis.crypto.subtle.digest('SHA-256', bytes)));
  } catch {
    return undefined;
  }
}

/** The reference an item pins for a slide group's newest revision: its place in the group's history
 *  (which carries no ordinal of its own) and the address of its body. Undefined when it cannot be read. */
export async function latestGroupRef(groupId: string): Promise<RevisionRef | undefined> {
  const answer = await request(API.contentHistory('slideGroup', groupId));
  if (!answer.ok || !Array.isArray(answer.data) || answer.data.length === 0) return undefined;
  const newest: unknown = answer.data[answer.data.length - 1];
  if (!isRecord(newest) || !isRecord(newest['body'])) return undefined;
  return { id: groupId, revision: answer.data.length, hash: await addressOf(newest['body']) };
}

/** The slide group generated from this song, newest first when there are several; undefined when none
 *  is. A generated group is named after its song, so only groups with that title are opened. */
export async function generatedGroupOf(song: Titled): Promise<SlideGroupRecord | undefined> {
  const listed = await request(API.library({ kind: 'slideGroup', q: song.title }));
  const candidates = listed.ok ? readTitled(listed.data) : undefined;
  if (candidates === undefined || !candidates.ok) return undefined;
  const found: SlideGroupRecord[] = [];
  for (const candidate of candidates.value) {
    const answer = await request(API.slideGroup(candidate.id));
    const group = answer.ok ? readSlideGroup(answer.data) : undefined;
    if (group?.body.generatedFrom?.['songId'] === song.id) found.push(group);
  }
  return found.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}
