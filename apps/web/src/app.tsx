// Route to page (SHELL-02). `route` is the one signal that decides what is on screen; this switch is the
// one place that turns it into a page, and a later spec adds a route by adding a case here and a match in
// `router.ts`, nothing else.
//
// Pages that need a session render inside the full shell; the welcome and sign-in forms render in the
// signed-out frame the shell falls back to without one. An output window is the exception to both: it
// is a full-window surface for a projector, so it renders on its own, with no shell around it at all.
//
// Until `boot()` has answered, the session is `undefined` and every route shows the loading line, so a
// deep link never flashes a page its viewer may not be allowed to see before the sign-in redirect.

import { session } from './app-state.js';
import { AppShell } from './components/app-shell.js';
import { t } from './i18n.js';
import { lazy } from './lazy.js';
import { NotFoundPage } from './pages/not-found.js';
import { ServicesPage } from './pages/services.js';
import { SignInPage } from './pages/sign-in.js';
import { WelcomePage } from './pages/welcome.js';
import { route } from './router.js';
import { signOut } from './sign-out.js';

import type { JSX } from 'preact';

const OutputPage = lazy(() => import('./pages/output.js').then((module) => module.OutputPage));
const ServicePage = lazy(() => import('./pages/service.js').then((module) => module.ServicePage));

/** What the current route renders inside the shell. */
function Page(): JSX.Element {
  const current = route.value;
  if (session.value === undefined) return <p role="status">{t('app.loading')}</p>;
  switch (current.name) {
    case 'services':
      return <ServicesPage />;
    case 'service':
      return <ServicePage id={current.id} />;
    case 'admin-users':
      return <h1>{t('users.title')}</h1>;
    case 'welcome':
      return <WelcomePage />;
    case 'sign-in':
      return <SignInPage next={current.next} />;
    // `boot()` moves `/` on to `/services`, `/welcome` or `/sign-in`; until it has, there is nothing to show.
    case 'root':
      return <p role="status">{t('app.loading')}</p>;
    // Rendered without the shell by `App`; listed so this switch stays total over every route.
    case 'output':
      return <OutputPage kind={current.kind} />;
    case 'not-found':
      return <NotFoundPage />;
  }
}

export interface AppProps {
  /** Replaces the usual session-ending action where an embedding host needs to own it. */
  readonly onSignOut?: () => void;
}

/** The whole client: an output surface on its own, every other route inside the shell. */
export function App({ onSignOut = () => void signOut() }: AppProps): JSX.Element {
  const current = route.value;
  if (current.name === 'output') return <OutputPage kind={current.kind} />;
  return (
    <AppShell onSignOut={onSignOut}>
      <Page />
    </AppShell>
  );
}
