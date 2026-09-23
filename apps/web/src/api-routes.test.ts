import { describe, expect, it } from 'vitest';

import { API } from './api-routes.js';

describe('API routes', () => {
  it('keeps the Phase A static paths exact', () => {
    expect({
      services: API.services,
      serviceCurrent: API.serviceCurrent,
      outputDefaults: API.outputDefaults,
      workspacePosition: API.workspacePosition,
      translations: API.translations,
      translationOffsets: API.translationOffsets,
      mediaUpload: API.mediaUpload,
    }).toEqual({
      services: '/api/v1/services', serviceCurrent: '/api/v1/services/current', outputDefaults: '/api/v1/output-defaults',
      workspacePosition: '/api/v1/me/workspace-position', translations: '/api/v1/translations',
      translationOffsets: '/api/v1/translation-offsets', mediaUpload: '/api/v1/media',
    });
  });

  it('encodes every dynamic identifier', () => {
    expect(API.service('a/b')).toBe('/api/v1/services/a%2Fb');
    expect(API.serviceDuplicate('a/b')).toBe('/api/v1/services/a%2Fb/duplicate');
    expect(API.serviceSchedule('a/b')).toBe('/api/v1/services/a%2Fb/schedule');
    expect(API.serviceTransition('a/b')).toBe('/api/v1/services/a%2Fb/transition');
    expect(API.serviceStatus('a/b')).toBe('/api/v1/services/a%2Fb/status');
    expect(API.serviceOutput('a/b')).toBe('/api/v1/services/a%2Fb/output');
    expect(API.serviceDrift('a/b')).toBe('/api/v1/services/a%2Fb/content-drift');
    expect(API.sectionItems('a/b', 'c/d')).toBe('/api/v1/services/a%2Fb/sections/c%2Fd/items');
    expect(API.sectionReorder('a/b', 'c/d')).toBe('/api/v1/services/a%2Fb/sections/c%2Fd/items/reorder');
    expect(API.item('a/b', 'c/d')).toBe('/api/v1/services/a%2Fb/items/c%2Fd');
    expect(API.itemAction('a/b', 'c/d', 'enable')).toBe('/api/v1/services/a%2Fb/items/c%2Fd/enable');
    expect(API.templateInstantiate('a/b')).toBe('/api/v1/service-templates/a%2Fb/instantiate');
    expect(API.canon('a/b')).toBe('/api/v1/translations/a%2Fb/canon');
    expect(API.verses('a/b', 'c/d', 3, '4/5')).toBe('/api/v1/translations/a%2Fb/verses?book=c%2Fd&chapter=3&verses=4%2F5');
    expect(API.translationOffset('a/b')).toBe('/api/v1/translation-offsets/a%2Fb');
    expect(API.media('a/b')).toBe('/api/v1/media/a%2Fb');
    expect(API.mediaContent('a/b')).toBe('/api/v1/media/a%2Fb/content');
    expect(API.mediaDerivative('a/b', 'c/d')).toBe('/api/v1/media/a%2Fb/derivatives/c%2Fd');
  });

  it('matches the content routes spec 02 serves', () => {
    const table: [string, string][] = [
      [API.mediaList(), '/api/v1/media'],
      [API.mediaList(true), '/api/v1/media?archived=true'],
      [API.mediaStatus('a/b'), '/api/v1/media/a%2Fb/status'],
      [API.mediaRetry('a/b'), '/api/v1/media/a%2Fb/retry'],
      [API.library(), '/api/v1/library'],
      [API.library({ kind: 'slideGroup', q: 'a b&c', archived: true }), '/api/v1/library?kind=slideGroup&q=a%20b%26c&archived=true'],
      [API.library({ archived: false }), '/api/v1/library'],
      [API.libraryEntry('a/b'), '/api/v1/library/a%2Fb'],
      [API.songs, '/api/v1/songs'],
      [API.song('a/b'), '/api/v1/songs/a%2Fb'],
      [API.song('a/b', 3), '/api/v1/songs/a%2Fb?revision=3'],
      [API.songRaw('a/b'), '/api/v1/songs/a%2Fb/raw'],
      [API.songRaw('a/b', 2), '/api/v1/songs/a%2Fb/raw?revision=2'],
      [API.songHistory('a/b'), '/api/v1/songs/a%2Fb/history'],
      [API.songSlides('a/b'), '/api/v1/songs/a%2Fb/slides'],
      [API.sermons, '/api/v1/sermons'],
      [API.sermon('a/b'), '/api/v1/sermons/a%2Fb'],
      [API.sermon('a/b', 4), '/api/v1/sermons/a%2Fb?revision=4'],
      [API.sermonHistory('a/b'), '/api/v1/sermons/a%2Fb/history'],
      [API.sermonSlides('a/b'), '/api/v1/sermons/a%2Fb/slides'],
      [API.slideGroups, '/api/v1/slide-groups'],
      [API.slideGroup('a/b'), '/api/v1/slide-groups/a%2Fb'],
      [API.slideGroupStatus('a/b'), '/api/v1/slide-groups/a%2Fb/status'],
      [API.slideGroupHistory('a/b'), '/api/v1/slide-groups/a%2Fb/history'],
      [API.slideOrder('a/b'), '/api/v1/slide-groups/a%2Fb/slide-order'],
      [API.slide('a/b', 'c/d'), '/api/v1/slide-groups/a%2Fb/slides/c%2Fd'],
      [API.slideDuplicate('a/b', 'c/d'), '/api/v1/slide-groups/a%2Fb/slides/c%2Fd/duplicate'],
      [API.slideLayoutOverride('a/b', 'c/d'), '/api/v1/slide-groups/a%2Fb/slides/c%2Fd/layout'],
      [API.slideBackgroundOverride('a/b', 'c/d'), '/api/v1/slide-groups/a%2Fb/slides/c%2Fd/background'],
      [API.languageBlockOrder('a/b', 'c/d'), '/api/v1/slide-groups/a%2Fb/slides/c%2Fd/language-block-order'],
      [API.languageBlockDuplicate('a/b', 'c/d', 'e/f'), '/api/v1/slide-groups/a%2Fb/slides/c%2Fd/language-blocks/e%2Ff/duplicate'],
      [API.contentLanguages, '/api/v1/content-languages/catalogue'],
      [API.slideLabels, '/api/v1/slide-labels/catalogue'],
      [API.slideLayouts(), '/api/v1/slide-layouts'],
      [API.slideLayouts(true), '/api/v1/slide-layouts?archived=true'],
      [API.slideLayout('a/b'), '/api/v1/slide-layouts/a%2Fb'],
      [API.slideLayout('a/b', 1), '/api/v1/slide-layouts/a%2Fb?revision=1'],
      [API.scriptureSearch('in the / beginning'), '/api/v1/scripture/search?q=in%20the%20%2F%20beginning'],
      [API.serviceTemplates, '/api/v1/service-templates'],
      [API.serviceTemplate('a/b'), '/api/v1/service-templates/a%2Fb'],
      [API.contentHistory('song', 'a/b'), '/api/v1/songs/a%2Fb/history'],
      [API.contentHistory('sermon', 'a/b'), '/api/v1/sermons/a%2Fb/history'],
      [API.contentHistory('slideGroup', 'a/b'), '/api/v1/slide-groups/a%2Fb/history'],
    ];
    for (const [actual, expected] of table) expect(actual).toBe(expected);
  });
});
