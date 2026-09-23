// The server's route paths, named once so a screen asks for `API.service(id)` instead of building a
// literal string the web app has no other way to keep in step with the server it calls.

import type { LibraryKind } from '@holydeck/contracts/library';

const enc = encodeURIComponent;

/** The kinds of reusable content that keep a revision history of their own. */
export type HistoryKind = 'song' | 'sermon' | 'slideGroup';

/** A Content Library listing's filter; every part is optional and archived entries are left out unless asked. */
export type LibraryQuery = { readonly kind?: LibraryKind; readonly q?: string; readonly archived?: boolean };

const withQuery = (path: string, query: Readonly<Record<string, string | undefined>>): string => {
  const parts = Object.entries(query).flatMap(([key, value]) => (value === undefined ? [] : [`${key}=${enc(value)}`]));
  return parts.length === 0 ? path : `${path}?${parts.join('&')}`;
};
const revisionQuery = (path: string, revision?: number): string =>
  withQuery(path, { revision: revision === undefined ? undefined : String(revision) });
const songPath = (id: string): string => `/api/v1/songs/${enc(id)}`;
const sermonPath = (id: string): string => `/api/v1/sermons/${enc(id)}`;
const slideGroupPath = (id: string): string => `/api/v1/slide-groups/${enc(id)}`;
const slidePath = (id: string, slideId: string): string => `${slideGroupPath(id)}/slides/${enc(slideId)}`;

export const API = {
  services: '/api/v1/services',
  serviceCurrent: '/api/v1/services/current',
  service: (id: string) => `/api/v1/services/${enc(id)}`,
  serviceDuplicate: (id: string) => `/api/v1/services/${enc(id)}/duplicate`,
  serviceSchedule: (id: string) => `/api/v1/services/${enc(id)}/schedule`,
  serviceTransition: (id: string) => `/api/v1/services/${enc(id)}/transition`,
  serviceStatus: (id: string) => `/api/v1/services/${enc(id)}/status`,
  serviceOutput: (id: string) => `/api/v1/services/${enc(id)}/output`,
  serviceDrift: (id: string) => `/api/v1/services/${enc(id)}/content-drift`,
  sectionItems: (id: string, sectionId: string) => `/api/v1/services/${enc(id)}/sections/${enc(sectionId)}/items`,
  sectionReorder: (id: string, sectionId: string) => `/api/v1/services/${enc(id)}/sections/${enc(sectionId)}/items/reorder`,
  item: (id: string, itemId: string) => `/api/v1/services/${enc(id)}/items/${enc(itemId)}`,
  itemAction: (id: string, itemId: string, action: 'enable' | 'disable' | 'duplicate' | 'revise' | 'body') =>
    `/api/v1/services/${enc(id)}/items/${enc(itemId)}/${action}`,
  outputDefaults: '/api/v1/output-defaults',
  workspacePosition: '/api/v1/me/workspace-position',
  templateInstantiate: (id: string) => `/api/v1/service-templates/${enc(id)}/instantiate`,
  translations: '/api/v1/translations',
  canon: (abbr: string) => `/api/v1/translations/${enc(abbr)}/canon`,
  verses: (abbr: string, book: string, chapter: number, verses: string) =>
    `/api/v1/translations/${enc(abbr)}/verses?book=${enc(book)}&chapter=${chapter}&verses=${enc(verses)}`,
  translationOffsets: '/api/v1/translation-offsets',
  translationOffset: (abbr: string) => `/api/v1/translation-offsets/${enc(abbr)}`,
  mediaContent: (id: string) => `/api/v1/media/${enc(id)}/content`,
  mediaDerivative: (id: string, name: string) => `/api/v1/media/${enc(id)}/derivatives/${enc(name)}`,
  media: (id: string) => `/api/v1/media/${enc(id)}`,
  mediaUpload: '/api/v1/media',
  mediaList: (archived?: boolean) => withQuery('/api/v1/media', { archived: archived === true ? 'true' : undefined }),
  mediaStatus: (id: string) => `/api/v1/media/${enc(id)}/status`,
  mediaRetry: (id: string) => `/api/v1/media/${enc(id)}/retry`,
  library: (filter: LibraryQuery = {}) =>
    withQuery('/api/v1/library', { kind: filter.kind, q: filter.q, archived: filter.archived === true ? 'true' : undefined }),
  libraryEntry: (id: string) => `/api/v1/library/${enc(id)}`,
  songs: '/api/v1/songs',
  song: (id: string, revision?: number) => revisionQuery(songPath(id), revision),
  songRaw: (id: string, revision?: number) => revisionQuery(`${songPath(id)}/raw`, revision),
  songHistory: (id: string) => `${songPath(id)}/history`,
  songSlides: (id: string) => `${songPath(id)}/slides`,
  sermons: '/api/v1/sermons',
  sermon: (id: string, revision?: number) => revisionQuery(sermonPath(id), revision),
  sermonHistory: (id: string) => `${sermonPath(id)}/history`,
  sermonSlides: (id: string) => `${sermonPath(id)}/slides`,
  slideGroups: '/api/v1/slide-groups',
  slideGroup: (id: string) => slideGroupPath(id),
  slideGroupStatus: (id: string) => `${slideGroupPath(id)}/status`,
  slideGroupHistory: (id: string) => `${slideGroupPath(id)}/history`,
  slideOrder: (id: string) => `${slideGroupPath(id)}/slide-order`,
  slide: (id: string, slideId: string) => slidePath(id, slideId),
  slideDuplicate: (id: string, slideId: string) => `${slidePath(id, slideId)}/duplicate`,
  slideLayoutOverride: (id: string, slideId: string) => `${slidePath(id, slideId)}/layout`,
  slideBackgroundOverride: (id: string, slideId: string) => `${slidePath(id, slideId)}/background`,
  languageBlockOrder: (id: string, slideId: string) => `${slidePath(id, slideId)}/language-block-order`,
  languageBlockDuplicate: (id: string, slideId: string, blockId: string) =>
    `${slidePath(id, slideId)}/language-blocks/${enc(blockId)}/duplicate`,
  contentLanguages: '/api/v1/content-languages/catalogue',
  slideLabels: '/api/v1/slide-labels/catalogue',
  slideLayouts: (archived?: boolean) => withQuery('/api/v1/slide-layouts', { archived: archived === true ? 'true' : undefined }),
  slideLayout: (id: string, revision?: number) => revisionQuery(`/api/v1/slide-layouts/${enc(id)}`, revision),
  scriptureSearch: (q: string) => `/api/v1/scripture/search?q=${enc(q)}`,
  serviceTemplates: '/api/v1/service-templates',
  serviceTemplate: (id: string) => `/api/v1/service-templates/${enc(id)}`,
  contentHistory: (kind: HistoryKind, id: string) =>
    kind === 'song' ? `${songPath(id)}/history` : kind === 'sermon' ? `${sermonPath(id)}/history` : `${slideGroupPath(id)}/history`,
} as const;
