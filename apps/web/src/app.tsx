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
const AdminUsersPage = lazy(() => import('./pages/admin-users.js').then((module) => module.AdminUsersPage));
const AdminSettingsPage = lazy(() => import('./pages/admin-settings.js').then((module) => module.AdminSettingsPage));
const AdminAuditPage = lazy(() => import('./pages/admin-audit.js').then((module) => module.AdminAuditPage));
const AdminJobsPage = lazy(() => import('./pages/admin-jobs.js').then((module) => module.AdminJobsPage));
const AdminOperationsPage = lazy(() => import('./pages/admin-operations.js').then((module) => module.AdminOperationsPage));
const AdminBackupsPage = lazy(() => import('./pages/admin-backups.js').then((module) => module.AdminBackupsPage));
const AdminIntegrationsPage = lazy(() => import('./pages/admin-integrations.js').then((module) => module.AdminIntegrationsPage));
const AdminLanguagesPage = lazy(() => import('./pages/admin-languages.js').then((module) => module.AdminLanguagesPage));
const AdminSlideLabelsPage = lazy(() => import('./pages/admin-slide-labels.js').then((module) => module.AdminSlideLabelsPage));
const HistoryPage = lazy(() => import('./pages/history.js').then((module) => module.HistoryPage));
const SecurityPage = lazy(() => import('./pages/account-security.js').then((module) => module.SecurityPage));
const AccountNotificationsPage = lazy(() =>
  import('./pages/account-notifications.js').then((module) => module.AccountNotificationsPage));
const WorkspacePage = lazy(() => import('./workspace/Workspace.js').then((module) => module.Workspace)) as
  (props: { readonly id: string }) => JSX.Element;
const NewServicePage = lazy(() => import('./workspace/NewService.js').then((module) => module.NewService));
const ReadinessPlaceholderPage = lazy(() =>
  import('./pages/readiness-placeholder.js').then((module) => module.ReadinessPlaceholderPage));
const ContentLibraryPage = lazy(() => import('./library/ContentLibrary.js').then((module) => module.ContentLibrary));
const MediaLibraryPage = lazy(() => import('./library/MediaLibrary.js').then((module) => module.MediaLibrary));

/** What the current route renders inside the shell. */
function Page(): JSX.Element {
  const current = route.value;
  if (session.value === undefined) return <p role="status">{t('app.loading')}</p>;
  switch (current.name) {
    case 'services':
      return <ServicesPage />;
    case 'service-new':
      return <NewServicePage />;
    case 'service':
      return <WorkspacePage id={current.id} />;
    case 'service-live':
      return <ServicePage id={current.id} />;
    case 'service-readiness':
      return <ReadinessPlaceholderPage id={current.id} />;
    case 'library':
      return <ContentLibraryPage />;
    case 'media':
      return <MediaLibraryPage />;
    case 'admin-users':
      return <AdminUsersPage />;
    case 'admin-settings':
      return <AdminSettingsPage />;
    case 'admin-audit':
      return <AdminAuditPage />;
    case 'admin-jobs':
      return <AdminJobsPage />;
    case 'admin-operations':
      return <AdminOperationsPage />;
    case 'admin-backups':
      return <AdminBackupsPage />;
    case 'admin-integrations':
      return <AdminIntegrationsPage />;
    case 'admin-languages':
      return <AdminLanguagesPage />;
    case 'admin-slide-labels':
      return <AdminSlideLabelsPage />;
    case 'account-security':
      return <SecurityPage />;
    case 'account-notifications':
      return <AccountNotificationsPage />;
    case 'content-history':
      return <HistoryPage contentId={current.contentId} />;
    case 'welcome':
      return <WelcomePage />;
    case 'sign-in':
      return <SignInPage next={current.next} notice={current.notice} add={current.add === true} />;
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
