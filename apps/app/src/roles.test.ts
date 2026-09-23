import { describe, expect, it } from 'vitest';

import {
  ACCOUNTS_MANAGE,
  AUDIT_READ,
  CATALOGUE_MANAGE,
  CONTENT_EDIT,
  CONTENT_HISTORY_MANAGE,
  INTEGRATIONS_MANAGE,
  LAYOUTS_MANAGE,
  MEDIA_MANAGE,
  PRESENCE_USE,
  PRESENTATION_CONTROL,
  PRESENTATION_VIEW,
  SERVICES_MANAGE,
  SERVICE_READ,
  SERVICE_TEMPLATES_MANAGE,
  SETTINGS_MANAGE,
  permissionsFor,
} from './roles.js';

import type { AccountRecord } from '@holydeck/contracts/accounts';

const ID = 'A'.repeat(22);

const accountOf = (role: AccountRecord['role'], controlPresentation: boolean): AccountRecord => ({
  id: ID,
  name: 'lucia',
  displayName: 'Lucia Brandt',
  role,
  createdAt: '2026-09-13T09:30:00.000Z',
  controlPresentation,
  disabled: false,
});

describe('what a role grants', () => {
  it('grants an admin accounts, settings, Layouts, media, services, Service Templates, content, catalogues, presence, history, audit and integrations', () => {
    expect(permissionsFor(accountOf('admin', false))).toEqual([
      ACCOUNTS_MANAGE,
      SETTINGS_MANAGE,
      LAYOUTS_MANAGE,
      SERVICE_TEMPLATES_MANAGE,
      MEDIA_MANAGE,
      SERVICES_MANAGE,
      CONTENT_EDIT,
      CATALOGUE_MANAGE,
      PRESENCE_USE,
      CONTENT_HISTORY_MANAGE,
      AUDIT_READ,
      INTEGRATIONS_MANAGE,
    ]);
  });

  it('grants an editor service management, content editing, presence and history, but neither catalogue nor Service Template management', () => {
    expect(SERVICES_MANAGE).toBe('services.manage');
    expect(permissionsFor(accountOf('editor', false))).toEqual([
      SERVICES_MANAGE,
      CONTENT_EDIT,
      PRESENCE_USE,
      CONTENT_HISTORY_MANAGE,
    ]);
    expect(permissionsFor(accountOf('editor', false))).not.toContain(SERVICE_TEMPLATES_MANAGE);
    expect(permissionsFor(accountOf('editor', false))).not.toContain(CATALOGUE_MANAGE);
  });

  it('grants a member presence by role alone', () => {
    expect(permissionsFor(accountOf('member', false))).toEqual([PRESENCE_USE]);
    expect(permissionsFor(accountOf('member', false))).not.toContain(SERVICE_TEMPLATES_MANAGE);
    expect(permissionsFor(accountOf('member', false))).not.toContain(CONTENT_EDIT);
  });
});

describe('what Control presentation is', () => {
  // It is granted per account, not implied by a role — an admin does not hold it just for being admin,
  // and an editor or a member holds it the moment it is granted to them, same as anyone else would.
  it('is independent of role: granted to an editor or a member, it is theirs', () => {
    expect(permissionsFor(accountOf('editor', true))).toEqual([
      SERVICES_MANAGE,
      CONTENT_EDIT,
      PRESENCE_USE,
      CONTENT_HISTORY_MANAGE,
      PRESENTATION_CONTROL,
      PRESENTATION_VIEW,
      SERVICE_READ,
    ]);
    expect(permissionsFor(accountOf('member', true))).toEqual([PRESENCE_USE, PRESENTATION_CONTROL, PRESENTATION_VIEW, SERVICE_READ]);
  });

  it('is not granted to an admin implicitly, whatever else admin carries', () => {
    expect(permissionsFor(accountOf('admin', false))).not.toContain(PRESENTATION_CONTROL);
  });

  it('adds to what the role already grants, rather than replacing it', () => {
    expect(permissionsFor(accountOf('admin', true))).toEqual([
      ACCOUNTS_MANAGE,
      SETTINGS_MANAGE,
      LAYOUTS_MANAGE,
      SERVICE_TEMPLATES_MANAGE,
      MEDIA_MANAGE,
      SERVICES_MANAGE,
      CONTENT_EDIT,
      CATALOGUE_MANAGE,
      PRESENCE_USE,
      CONTENT_HISTORY_MANAGE,
      AUDIT_READ,
      INTEGRATIONS_MANAGE,
      PRESENTATION_CONTROL,
      PRESENTATION_VIEW,
      SERVICE_READ,
    ]);
  });

  it('is gone the moment it is revoked, whatever role carried it', () => {
    const held = accountOf('editor', true);
    const revoked = { ...held, controlPresentation: false };
    expect(permissionsFor(held)).toContain(PRESENTATION_CONTROL);
    expect(permissionsFor(revoked)).not.toContain(PRESENTATION_CONTROL);
  });
});

// D-2: PRESENTATION_VIEW and SERVICE_READ have no standalone grant path — an account holds either one
// only for the same reason it holds PRESENTATION_CONTROL, and loses all three together.
describe('what PRESENTATION_VIEW and SERVICE_READ are', () => {
  it('are granted the same way Control presentation is, never on their own', () => {
    expect(permissionsFor(accountOf('member', true))).toEqual(expect.arrayContaining([PRESENTATION_VIEW, SERVICE_READ]));
    expect(permissionsFor(accountOf('member', false))).not.toContain(PRESENTATION_VIEW);
    expect(permissionsFor(accountOf('member', false))).not.toContain(SERVICE_READ);
  });

  it('are gone the moment Control presentation is revoked', () => {
    const held = accountOf('member', true);
    const revoked = { ...held, controlPresentation: false };
    expect(permissionsFor(revoked)).not.toContain(PRESENTATION_VIEW);
    expect(permissionsFor(revoked)).not.toContain(SERVICE_READ);
  });
});

describe('the permission list itself', () => {
  it('is frozen, because what a session was granted at sign-in does not change under it', () => {
    expect(Object.isFrozen(permissionsFor(accountOf('member', false)))).toBe(true);
  });
});
