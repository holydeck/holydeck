// The server's route paths, named once so a screen asks for `API.service(id)` instead of building a
// literal string the web app has no other way to keep in step with the server it calls.

const enc = encodeURIComponent;

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
  mediaUpload: '/api/v1/media',
} as const;
