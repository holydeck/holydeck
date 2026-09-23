// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAppState, session } from '../app-state.js';
import { currentPath } from '../router.js';
import { AppShell } from './app-shell.js';

import type { SessionView } from '@holydeck/contracts/sessions';

const signedIn = (permissions: readonly string[], role: 'admin' | 'editor' | 'member' = 'admin'): SessionView =>
  ({
    csrf: 'c'.repeat(43),
    permissions,
    slots: [],
    account: { id: 'a1', name: 'ruth', displayName: 'Ruth Example', role, controlPresentation: false },
  }) as unknown as SessionView;

describe('the navigation shell', () => {
  beforeEach(() => {
    resetAppState();
    currentPath.value = '/services';
  });

  it('keeps only the skip link, main and live regions while signed out', () => {
    session.value = null;
    render(<AppShell><p>form</p></AppShell>);
    expect(screen.getByRole('link', { name: 'Skip to main content' }).getAttribute('href')).toBe('#main');
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('banner')).toBeNull();
    expect(screen.getByRole('main').id).toBe('main');
    expect(document.getElementById('announce-polite')?.getAttribute('aria-live')).toBe('polite');
    expect(document.getElementById('announce-assertive')?.getAttribute('aria-live')).toBe('assertive');
  });

  it('names who is signed in, their role, and offers sign-out', () => {
    session.value = signedIn(['accounts.manage']);
    const signOut = vi.fn();
    render(<AppShell onSignOut={signOut}><p>page</p></AppShell>);
    expect(screen.getByText('Signed in as Ruth Example')).toBeTruthy();
    expect(screen.getByText('Administrator')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalledOnce();
  });

  it('shows Administration only to a session that administers accounts or settings', () => {
    session.value = signedIn([], 'editor');
    const view = render(<AppShell><p>page</p></AppShell>);
    expect(screen.queryByRole('link', { name: 'Administration' })).toBeNull();
    expect(screen.getByText('Editor')).toBeTruthy();
    view.unmount();

    session.value = signedIn(['settings.manage']);
    render(<AppShell><p>page</p></AppShell>);
    expect(screen.getByRole('link', { name: 'Administration' }).getAttribute('href')).toBe('/admin/settings');
  });

  it('opens Administration for every permission an admin page asks for, at the first page it may see', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['accounts.manage', '/admin/users'],
      ['settings.manage', '/admin/settings'],
      ['audit.read', '/admin/audit'],
      ['integrations.manage', '/admin/integrations'],
      ['catalogue.manage', '/admin/languages'],
    ];
    for (const [permission, href] of cases) {
      session.value = signedIn([permission], 'editor');
      const view = render(<AppShell><p>page</p></AppShell>);
      expect(screen.getByRole('link', { name: 'Administration' }).getAttribute('href')).toBe(href);
      view.unmount();
    }
  });

  it('lists each admin page the session may open while in Administration, marking the current one', () => {
    session.value = signedIn(['accounts.manage', 'settings.manage', 'audit.read', 'integrations.manage', 'catalogue.manage']);
    render(<AppShell><p>page</p></AppShell>);
    expect(screen.queryByRole('navigation', { name: 'Administration' })).toBeNull();

    act(() => {
      currentPath.value = '/admin/audit';
    });
    const admin = screen.getByRole('navigation', { name: 'Administration' });
    const links = [...admin.querySelectorAll('a')].map((link) => [link.textContent, link.getAttribute('href')]);
    expect(links).toEqual([
      ['Users', '/admin/users'],
      ['Settings', '/admin/settings'],
      ['Audit log', '/admin/audit'],
      ['Integrations', '/admin/integrations'],
      ['Content languages', '/admin/languages'],
      ['Slide labels', '/admin/slide-labels'],
    ]);
    expect(admin.querySelector('a[href="/admin/audit"]')?.getAttribute('aria-current')).toBe('page');
    expect(admin.querySelector('a[href="/admin/users"]')?.getAttribute('aria-current')).toBeNull();
  });

  it('leaves out the admin pages a session may not open', () => {
    session.value = signedIn(['catalogue.manage'], 'editor');
    currentPath.value = '/admin/slide-labels';
    render(<AppShell><p>page</p></AppShell>);
    const admin = screen.getByRole('navigation', { name: 'Administration' });
    expect([...admin.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual([
      '/admin/languages',
      '/admin/slide-labels',
    ]);
  });

  it('marks the current section and links to the library', () => {
    session.value = signedIn(['accounts.manage']);
    currentPath.value = '/services/s1';
    render(<AppShell><p>page</p></AppShell>);
    expect(screen.getByRole('link', { name: 'Services' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Administration' }).getAttribute('aria-current')).toBeNull();
    expect(screen.getByRole('link', { name: 'Library' }).getAttribute('href')).toBe('/library');
    expect(screen.getByRole('link', { name: 'Library' }).getAttribute('aria-current')).toBeNull();

    act(() => {
      currentPath.value = '/admin/users';
    });
    expect(screen.getByRole('link', { name: 'Administration' }).getAttribute('aria-current')).toBe('page');
  });

  it('offers Security to every signed-in session, and marks it current on its own route', () => {
    session.value = signedIn([], 'editor');
    render(<AppShell><p>page</p></AppShell>);
    expect(screen.getByRole('link', { name: 'Security' }).getAttribute('href')).toBe('/account/security');
    expect(screen.getByRole('link', { name: 'Security' }).getAttribute('aria-current')).toBeNull();

    act(() => {
      currentPath.value = '/account/security';
    });
    expect(screen.getByRole('link', { name: 'Security' }).getAttribute('aria-current')).toBe('page');
  });

  it('marks the library current while on it', () => {
    session.value = signedIn(['accounts.manage']);
    currentPath.value = '/library';
    render(<AppShell><p>page</p></AppShell>);
    expect(screen.getByRole('link', { name: 'Library' }).getAttribute('aria-current')).toBe('page');
  });

  it('shows the Media link only to a session that can manage media', () => {
    session.value = signedIn(['accounts.manage']);
    const view = render(<AppShell><p>page</p></AppShell>);
    expect(screen.queryByRole('link', { name: 'Media' })).toBeNull();
    view.unmount();

    session.value = signedIn(['accounts.manage', 'media.manage']);
    render(<AppShell><p>page</p></AppShell>);
    expect(screen.getByRole('link', { name: 'Media' }).getAttribute('href')).toBe('/media');
  });

  it('omits the account line for a session with no account behind it, and sign-out when it is not wired', () => {
    session.value = { ...signedIn([]), account: undefined } as unknown as SessionView;
    render(<AppShell><p>page</p></AppShell>);
    expect(screen.getByText('HolyDeck')).toBeTruthy();
    expect(screen.queryByText(/Signed in as/u)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });

  it('never resets what was last said in a live region when it re-renders', () => {
    session.value = null;
    render(<AppShell><p>page</p></AppShell>);
    const polite = document.getElementById('announce-polite') as HTMLElement;
    polite.textContent = 'Saved';
    act(() => {
      session.value = signedIn([]);
    });
    expect(screen.getByRole('navigation')).toBeTruthy();
    expect(document.getElementById('announce-polite')?.textContent).toBe('Saved');
  });

  it('allows every navigation label to grow by 30% without nowrap or hidden overflow', () => {
    session.value = signedIn(['accounts.manage']);
    render(<AppShell><p>page</p></AppShell>);
    const controls = [...document.querySelectorAll('.app-nav a')];

    for (const control of controls) {
      const original = control.textContent ?? '';
      control.textContent = original + 'x'.repeat(Math.ceil(original.length * 0.3));
      expect(control.textContent.length).toBeGreaterThanOrEqual(Math.ceil(original.length * 1.3));
      expect(getComputedStyle(control).whiteSpace).not.toBe('nowrap');
      expect(getComputedStyle(control).overflow).not.toBe('hidden');
    }
  });
});
