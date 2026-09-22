import { describe, expect, it } from 'vitest';

import {
  ACCOUNTS_MANAGE,
  LAYOUTS_MANAGE,
  MEDIA_MANAGE,
  PRESENTATION_CONTROL,
  SERVICES_MANAGE,
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
  it('grants an admin accounts, settings, Layouts, media, services and Service Templates', () => {
    expect(permissionsFor(accountOf('admin', false))).toEqual([
      ACCOUNTS_MANAGE,
      SETTINGS_MANAGE,
      LAYOUTS_MANAGE,
      SERVICE_TEMPLATES_MANAGE,
      MEDIA_MANAGE,
      SERVICES_MANAGE,
    ]);
  });

  it('grants an editor service management, but not Service Template management, by role alone', () => {
    expect(SERVICES_MANAGE).toBe('services.manage');
    expect(permissionsFor(accountOf('editor', false))).toEqual([SERVICES_MANAGE]);
    expect(permissionsFor(accountOf('editor', false))).not.toContain(SERVICE_TEMPLATES_MANAGE);
  });

  it('grants a member nothing by role alone', () => {
    expect(permissionsFor(accountOf('member', false))).toEqual([]);
    expect(permissionsFor(accountOf('member', false))).not.toContain(SERVICE_TEMPLATES_MANAGE);
  });
});

describe('what Control presentation is', () => {
  // It is granted per account, not implied by a role — an admin does not hold it just for being admin,
  // and an editor or a member holds it the moment it is granted to them, same as anyone else would.
  it('is independent of role: granted to an editor or a member, it is theirs', () => {
    expect(permissionsFor(accountOf('editor', true))).toEqual([
      SERVICES_MANAGE,
      PRESENTATION_CONTROL,
    ]);
    expect(permissionsFor(accountOf('member', true))).toEqual([PRESENTATION_CONTROL]);
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
      PRESENTATION_CONTROL,
    ]);
  });

  it('is gone the moment it is revoked, whatever role carried it', () => {
    const held = accountOf('editor', true);
    const revoked = { ...held, controlPresentation: false };
    expect(permissionsFor(held)).toContain(PRESENTATION_CONTROL);
    expect(permissionsFor(revoked)).not.toContain(PRESENTATION_CONTROL);
  });
});

describe('the permission list itself', () => {
  it('is frozen, because what a session was granted at sign-in does not change under it', () => {
    expect(Object.isFrozen(permissionsFor(accountOf('member', false)))).toBe(true);
  });
});
