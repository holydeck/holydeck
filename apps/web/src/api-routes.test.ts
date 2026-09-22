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
    expect(API.mediaContent('a/b')).toBe('/api/v1/media/a%2Fb/content');
    expect(API.mediaDerivative('a/b', 'c/d')).toBe('/api/v1/media/a%2Fb/derivatives/c%2Fd');
  });
});
