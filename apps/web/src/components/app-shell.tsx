// The frame every signed-in screen sits in (SHELL-03): a skip link, the top bar, the primary navigation,
// one `<main>` that focus lands on after a navigation, and the two live regions every announcement in
// the client is said in.
//
// The live regions are rendered here, once, at the top of the tree rather than by the page that first
// needs them: a region inserted and written to in the same task is often never announced, and
// `announcements.ts` checks for both by id as soon as it is bound. They never update after the first render,
// so no re-render of the shell can reset the text `announcements.ts` or `status.ts` last wrote into them.
//
// Signed out, the shell keeps only the skip link, `<main>` and the regions: the welcome and sign-in forms
// have nothing to navigate to yet, and a top bar naming nobody would only be noise to a screen reader.

import { Component } from 'preact';
import { useState } from 'preact/hooks';

import { ACCOUNT_ROLES, type AccountRole } from '@holydeck/contracts/accounts';
import type { MessageKey } from '@holydeck/localization/messages';

import { switchAccount } from '../account-switch.js';
import { can, session } from '../app-state.js';
import { ExpiryBanner } from './expiry-banner.js';
import { t } from '../i18n.js';
import { route, type Route } from '../router.js';
import { ToastRegion } from './toast.js';
import { UpdateDialog } from './update-dialog.js';

import type { SessionView } from '@holydeck/contracts/sessions';
import type { ComponentChildren, JSX } from 'preact';

/**
 * The permissions that open the Administration area. Spelled as the server's `roles.ts` spells them;
 * the web client cannot import the server package, and a session's `permissions` list is the only place
 * the client learns them from anyway.
 */
export const ADMINISTRATION_PERMISSIONS = Object.freeze([
  'accounts.manage',
  'settings.manage',
  'audit.read',
  'integrations.manage',
  'catalogue.manage',
] as const);

type AdministrationPermission = (typeof ADMINISTRATION_PERMISSIONS)[number];

/**
 * Every Administration page, in the order its sub-navigation lists them, with the permission the page
 * itself checks before it loads anything. A session sees only the pages it may open, and the
 * Administration link leads to the first of them: a settings-only administrator landing on Users would
 * meet nothing but a refusal.
 */
const ADMINISTRATION_PAGES: readonly {
  readonly route: Route['name'];
  readonly href: string;
  readonly label: MessageKey;
  readonly permission: AdministrationPermission;
}[] = [
  { route: 'admin-users', href: '/admin/users', label: 'users.title', permission: 'accounts.manage' },
  { route: 'admin-settings', href: '/admin/settings', label: 'settings.title', permission: 'settings.manage' },
  { route: 'admin-audit', href: '/admin/audit', label: 'audit.heading', permission: 'audit.read' },
  { route: 'admin-integrations', href: '/admin/integrations', label: 'integrations.heading', permission: 'integrations.manage' },
  { route: 'admin-languages', href: '/admin/languages', label: 'languages.heading', permission: 'catalogue.manage' },
  { route: 'admin-slide-labels', href: '/admin/slide-labels', label: 'slideLabels.heading', permission: 'catalogue.manage' },
];

const roleLabel = (role: AccountRole): string => t(`app.role.${role}`);

/** Which primary section a route belongs to, so its link can say `aria-current="page"`. */
const sectionOf = (current: Route): 'services' | 'library' | 'media' | 'administration' | 'security' | undefined => {
  if (
    current.name === 'services' ||
    current.name === 'service-new' ||
    current.name === 'service' ||
    current.name === 'service-live' ||
    current.name === 'service-readiness'
  ) {
    return 'services';
  }
  if (current.name === 'library') return 'library';
  if (current.name === 'media') return 'media';
  if (ADMINISTRATION_PAGES.some((page) => page.route === current.name)) return 'administration';
  if (current.name === 'account-security') return 'security';
  return undefined;
};

/**
 * The account menu (COLAB-08): every other account signed in to this browser container, by name, and the
 * way to add one more. A switch reloads the whole tab, so nothing here outlives it; only a refusal stays.
 */
function AccountMenu({ current }: { readonly current: SessionView }): JSX.Element {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const others = current.slots.filter((slot) => slot.actor !== current.actor);

  const switchTo = async (slotId: string): Promise<void> => {
    setBusy(slotId);
    setError(undefined);
    try {
      setError(await switchAccount(slotId));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <details class="app-account-menu">
      <summary>{t('app.account.menu')}</summary>
      {error === undefined ? null : <p role="alert">{error}</p>}
      <ul>
        {others.map((slot) => (
          <li key={slot.slotId}>
            <button type="button" onClick={() => void switchTo(slot.slotId)} disabled={busy !== undefined}>
              {t('app.account.switchTo', { name: slot.displayName ?? slot.actor })}
            </button>
          </li>
        ))}
        <li>
          <a href="/sign-in?add=1">{t('app.account.add')}</a>
        </li>
      </ul>
    </details>
  );
}

/** The two regions, rendered once and never re-rendered: their text belongs to whoever last spoke. */
class LiveRegions extends Component {
  override shouldComponentUpdate(): boolean {
    return false;
  }

  override render(): JSX.Element {
    return (
      <>
        <p id="announce-polite" class="visually-hidden" aria-live="polite"></p>
        <p id="announce-assertive" class="visually-hidden" aria-live="assertive"></p>
      </>
    );
  }
}

export interface AppShellProps {
  readonly children: ComponentChildren;
  /** What the sign-out button does. Absent until sign-out is wired, when the button is not shown. */
  readonly onSignOut?: () => void;
}

/** The skip link, top bar, navigation, main landmark and live regions around one page. */
export function AppShell({ children, onSignOut }: AppShellProps): JSX.Element {
  const current = session.value;
  const account = current?.account;
  const section = sectionOf(route.value);
  const adminPages = ADMINISTRATION_PAGES.filter((page) => can(page.permission));
  const managesMedia = can('media.manage');

  return (
    <>
      <a class="skip-link" href="#main">{t('app.skipToMain')}</a>
      {current == null ? null : (
        <header class="app-bar">
          <p class="app-name">HolyDeck</p>
          {account === undefined || !ACCOUNT_ROLES.includes(account.role) ? null : (
            <p class="app-account">
              <span>{t('app.account.signedInAs', { name: account.displayName })}</span>
              <span class="app-role">{roleLabel(account.role)}</span>
            </p>
          )}
          <AccountMenu current={current} />
          {onSignOut === undefined ? null : (
            <button type="button" class="app-sign-out" onClick={onSignOut}>{t('app.signOut')}</button>
          )}
        </header>
      )}
      {current == null ? null : (
        <nav class="app-nav" aria-label={t('app.nav.label')}>
          <ul>
            <li>
              <a href="/services" aria-current={section === 'services' ? 'page' : undefined}>{t('app.nav.services')}</a>
            </li>
            <li>
              <a href="/library" aria-current={section === 'library' ? 'page' : undefined}>{t('app.nav.library')}</a>
            </li>
            {managesMedia ? (
              <li>
                <a href="/media" aria-current={section === 'media' ? 'page' : undefined}>{t('app.nav.media')}</a>
              </li>
            ) : null}
            {adminPages[0] === undefined ? null : (
              <li>
                <a href={adminPages[0].href} aria-current={section === 'administration' ? 'page' : undefined}>
                  {t('app.nav.administration')}
                </a>
              </li>
            )}
            <li>
              <a href="/account/security" aria-current={section === 'security' ? 'page' : undefined}>
                {t('app.nav.security')}
              </a>
            </li>
          </ul>
          {section === 'administration' && adminPages.length > 0 ? (
            <nav class="app-subnav" aria-label={t('app.nav.administration')}>
              <ul>
                {adminPages.map((page) => (
                  <li key={page.href}>
                    <a href={page.href} aria-current={route.value.name === page.route ? 'page' : undefined}>
                      {t(page.label)}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
        </nav>
      )}
      <ExpiryBanner />
      <main id="main" tabindex={-1}>{children}</main>
      <UpdateDialog />
      <ToastRegion />
      <LiveRegions />
    </>
  );
}
