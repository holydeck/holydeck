// The application has one deliberately small client-side route vocabulary, so screens can ask what they
// should render without each one parsing browser URLs and deciding which malformed paths are meaningful.
// It also owns history interception here, leaving ordinary fragment navigation to the browser because
// the service workspace uses fragments as its accessible panel targets.

import { computed, signal, type ReadonlySignal, type Signal } from '@preact/signals';

/** Every page the web application can render from a same-origin path. */
export type Route =
  | { readonly name: 'root' }
  | {
      readonly name: 'sign-in';
      readonly next: string | undefined;
      readonly notice: 'claim-sign-in-refused' | undefined;
      /** Set when a signed-in tab opens sign-in to add another account to its container (COLAB-08). */
      readonly add?: true;
    }
  | { readonly name: 'welcome' }
  | { readonly name: 'services' }
  | { readonly name: 'service-new' }
  | { readonly name: 'service'; readonly id: string }
  | { readonly name: 'service-live'; readonly id: string }
  | { readonly name: 'service-readiness'; readonly id: string; readonly intent: 'prepare' | 'present' }
  | { readonly name: 'library' }
  | { readonly name: 'media' }
  | { readonly name: 'admin-users' }
  | { readonly name: 'admin-settings' }
  | { readonly name: 'admin-audit' }
  | { readonly name: 'admin-jobs' }
  | { readonly name: 'admin-operations' }
  | { readonly name: 'admin-backups' }
  | { readonly name: 'admin-integrations' }
  | { readonly name: 'admin-languages' }
  | { readonly name: 'admin-slide-labels' }
  | { readonly name: 'account-security' }
  | { readonly name: 'content-history'; readonly contentId: string }
  | { readonly name: 'output'; readonly kind: string }
  | { readonly name: 'not-found' };

const pathAt = (location: Pick<Location, 'pathname' | 'search'> | undefined): string =>
  location === undefined ? '/' : `${location.pathname}${location.search}`;

/** The browser path as the application sees it, without a fragment that belongs to the current document. */
export const currentPath: Signal<string> = signal(pathAt(globalThis.location));

/** The route derived from the current path, kept reactive so a render never needs to subscribe manually. */
export const route: ReadonlySignal<Route> = computed(() => matchRoute(currentPath.value));

const notFound = (): Route => ({ name: 'not-found' });

const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });

/**
 * Reads a browser path into the one route it names. Query parameters belong only to sign-in at present;
 * every other route is matched by its pathname so an accidental extra segment cannot render the wrong
 * service or output surface.
 */
export function matchRoute(pathWithSearch: string): Route {
  const withoutFragment = pathWithSearch.split('#', 1)[0] ?? '';
  const question = withoutFragment.indexOf('?');
  const pathname = question === -1 ? withoutFragment : withoutFragment.slice(0, question);
  const search = question === -1 ? '' : withoutFragment.slice(question + 1);

  if (pathname === '/') return { name: 'root' };
  if (pathname === '/sign-in') {
    const parameters = new URLSearchParams(search);
    return {
      name: 'sign-in',
      next: safeNext(parameters.get('next')),
      notice: parameters.get('notice') === 'claim-sign-in-refused' ? 'claim-sign-in-refused' : undefined,
      ...(parameters.get('add') === '1' ? { add: true as const } : {}),
    };
  }
  if (pathname === '/welcome') return { name: 'welcome' };
  if (pathname === '/services' || pathname === '/services/') return { name: 'services' };
  if (pathname === '/services/new') return { name: 'service-new' };
  if (pathname === '/library') return { name: 'library' };
  if (pathname === '/media') return { name: 'media' };
  if (pathname === '/admin/users') return { name: 'admin-users' };
  if (pathname === '/admin/settings') return { name: 'admin-settings' };
  if (pathname === '/admin/audit') return { name: 'admin-audit' };
  if (pathname === '/admin/jobs') return { name: 'admin-jobs' };
  if (pathname === '/admin/operations') return { name: 'admin-operations' };
  if (pathname === '/admin/backups') return { name: 'admin-backups' };
  if (pathname === '/admin/integrations') return { name: 'admin-integrations' };
  if (pathname === '/admin/languages') return { name: 'admin-languages' };
  if (pathname === '/admin/slide-labels') return { name: 'admin-slide-labels' };
  if (pathname === '/account/security') return { name: 'account-security' };

  const serviceLive = /^\/services\/([^/]+)\/live$/u.exec(pathname);
  if (serviceLive !== null) {
    try {
      return { name: 'service-live', id: decodeURIComponent(serviceLive[1] ?? '') };
    } catch {
      return notFound();
    }
  }

  const serviceReadiness = /^\/services\/([^/]+)\/readiness$/u.exec(pathname);
  if (serviceReadiness !== null) {
    try {
      const intent = new URLSearchParams(search).get('intent') === 'present' ? 'present' : 'prepare';
      return { name: 'service-readiness', id: decodeURIComponent(serviceReadiness[1] ?? ''), intent };
    } catch {
      return notFound();
    }
  }

  const service = /^\/services\/([^/]+)$/u.exec(pathname);
  if (service !== null) {
    try {
      return { name: 'service', id: decodeURIComponent(service[1] ?? '') };
    } catch {
      return notFound();
    }
  }

  const contentHistory = /^\/content\/([^/]+)\/history$/u.exec(pathname);
  if (contentHistory !== null) {
    try {
      return { name: 'content-history', contentId: decodeURIComponent(contentHistory[1] ?? '') };
    } catch {
      return notFound();
    }
  }

  const output = /^\/output\/([^/]+)$/u.exec(pathname);
  return output === null ? notFound() : { name: 'output', kind: output[1] ?? '' };
}

const focusMain = (): void => {
  if (typeof document === 'undefined') return;
  queueMicrotask(() => document.getElementById('main')?.focus());
};

/** Moves to a new same-origin application path and gives the replacement page's main landmark focus. */
export function navigate(path: string, options: { readonly replace?: boolean } = {}): void {
  if (path === currentPath.value) return;
  if (typeof history !== 'undefined') {
    if (options.replace === true) history.replaceState({}, '', path);
    else history.pushState({}, '', path);
  }
  currentPath.value = path;
  focusMain();
}

/**
 * Starts synchronising browser history with `currentPath`, and makes ordinary same-origin links client
 * navigation. Its returned stopper lets a mounting root detach both listeners before another root takes
 * ownership of the same document.
 */
export function startRouter(win: Window): () => void {
  const update = (): void => {
    currentPath.value = pathAt(win.location);
  };
  const clicked = (event: MouseEvent): void => {
    const target = event.target as (EventTarget & { closest?: (selector: string) => Element | null }) | null;
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.defaultPrevented ||
      target === null ||
      target.closest === undefined
    ) {
      return;
    }
    const anchor = target.closest('a') as HTMLAnchorElement | null;
    if (
      anchor === null ||
      !anchor.hasAttribute('href') ||
      (anchor.hasAttribute('target') && anchor.getAttribute('target') !== '_self') ||
      anchor.hasAttribute('download')
    ) {
      return;
    }

    const url = new URL(anchor.href, win.location.href);
    if (url.origin !== win.location.origin) return;
    if (url.hash !== '' && `${url.pathname}${url.search}` === `${win.location.pathname}${win.location.search}`) return;

    event.preventDefault();
    navigate(`${url.pathname}${url.search}`);
  };

  update();
  win.addEventListener('popstate', update);
  win.document.addEventListener('click', clicked);
  return (): void => {
    win.removeEventListener('popstate', update);
    win.document.removeEventListener('click', clicked);
  };
}

/** Rejects a next path that could leave this origin, confuse a browser, or send sign-in into a loop. */
export function safeNext(raw: string | null | undefined): string | undefined {
  if (
    typeof raw !== 'string' ||
    raw === '' ||
    raw.includes('\\') ||
    hasControlCharacter(raw) ||
    (raw !== '/' && !/^\/[^/\\]/u.test(raw)) ||
    raw.startsWith('/sign-in')
  ) {
    return undefined;
  }
  return raw;
}

/** Builds the sign-in address for a path that is safe to return to after a new session is established. */
export function signInPathFor(path: string): string {
  const next = safeNext(path);
  return next === undefined || next === '/' ? '/sign-in' : `/sign-in?next=${encodeURIComponent(next)}`;
}
