// @vitest-environment happy-dom

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import { currentPath, matchRoute, navigate, safeNext, signInPathFor, startRouter } from './router.js';

let stop: (() => void) | undefined;

beforeEach(() => {
  stop = undefined;
  document.body.replaceChildren();
  history.replaceState({}, '', '/');
  currentPath.value = '/';
});

afterEach(() => {
  stop?.();
  vi.restoreAllMocks();
});

describe('matchRoute', () => {
  it.each([
    ['/', { name: 'root' }],
    ['/sign-in?next=%2Fservices', { name: 'sign-in', next: '/services', notice: undefined }],
    ['/sign-in?notice=claim-sign-in-refused', { name: 'sign-in', next: undefined, notice: 'claim-sign-in-refused' }],
    ['/welcome', { name: 'welcome' }],
    ['/services', { name: 'services' }],
    ['/services/', { name: 'services' }],
    ['/services/church%20service', { name: 'service', id: 'church service' }],
    ['/admin/users', { name: 'admin-users' }],
    ['/account/security', { name: 'account-security' }],
    ['/output/audience', { name: 'output', kind: 'audience' }],
    ['/services/a/b', { name: 'not-found' }],
    ['/services/%E0%A4%A', { name: 'not-found' }],
    ['/missing#section', { name: 'not-found' }],
  ] as const)('reads %s', (path, expected) => {
    expect(matchRoute(path)).toEqual(expected);
  });

  it.each([
    ['/services/new', { name: 'service-new' }],
    ['/services/abc', { name: 'service', id: 'abc' }],
    ['/services/abc/live', { name: 'service-live', id: 'abc' }],
    ['/services/abc/readiness', { name: 'service-readiness', id: 'abc', intent: 'prepare' }],
    ['/services/abc/readiness?intent=present', { name: 'service-readiness', id: 'abc', intent: 'present' }],
    ['/library', { name: 'library' }],
    ['/media', { name: 'media' }],
    ['/services/abc/unknown', { name: 'not-found' }],
  ])('matches %s', (path, expected) => {
    expect(matchRoute(path)).toEqual(expected);
  });
});

describe('navigate', () => {
  it('pushes a new path, replaces when asked, and leaves its current path alone when it is already there', () => {
    const pushed = vi.spyOn(history, 'pushState');
    const replaced = vi.spyOn(history, 'replaceState');

    navigate('/services');
    expect(pushed).toHaveBeenCalledWith({}, '', '/services');
    expect(currentPath.value).toBe('/services');

    navigate('/welcome', { replace: true });
    expect(replaced).toHaveBeenCalledWith({}, '', '/welcome');
    expect(currentPath.value).toBe('/welcome');

    navigate('/welcome');
    expect(pushed).toHaveBeenCalledTimes(1);
  });

  it('moves focus to the newly rendered main landmark', async () => {
    const main = document.createElement('main');
    main.id = 'main';
    main.tabIndex = -1;
    document.body.append(main);

    navigate('/services');
    await Promise.resolve();
    expect(document.activeElement).toBe(main);
  });
});

describe('startRouter', () => {
  it('keeps popstate in step with the browser location', () => {
    stop = startRouter(window);
    history.pushState({}, '', '/services');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(currentPath.value).toBe('/services');
  });

  it('intercepts an ordinary same-origin application link', () => {
    const anchor = document.createElement('a');
    anchor.href = '/services/example';
    document.body.append(anchor);
    const pushed = vi.spyOn(history, 'pushState');
    stop = startRouter(window);

    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, cancelable: true }));

    expect(pushed).toHaveBeenCalledWith({}, '', '/services/example');
    expect(currentPath.value).toBe('/services/example');
  });

  it('leaves an in-page panel link to the browser and does not navigate to the same path', () => {
    history.replaceState({}, '', '/services/example');
    currentPath.value = '/services/example';
    const anchor = document.createElement('a');
    anchor.href = '#order';
    document.body.append(anchor);
    const pushed = vi.spyOn(history, 'pushState');
    stop = startRouter(window);

    const click = new MouseEvent('click', { bubbles: true, button: 0, cancelable: true });
    anchor.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(false);
    expect(pushed).not.toHaveBeenCalled();
    expect(currentPath.value).toBe('/services/example');
  });

  it.each([
    ['a modifier key', '/services/example', { ctrlKey: true }],
    ['the middle button', '/services/example', { button: 1 }],
    ['a new browsing context', '/services/example', { target: '_blank' }],
    ['a download', '/services/example', { download: '' }],
    ['another origin', 'https://evil.example/services/example', {}],
    ['an already prevented event', '/services/example', { prevented: true }],
  ] as const)('does not intercept %s', (_reason, href, options) => {
    const anchor = document.createElement('a');
    anchor.href = href;
    if ('target' in options) anchor.target = options.target;
    if ('download' in options) anchor.download = options.download;
    if ('prevented' in options && options.prevented) anchor.addEventListener('click', (event) => event.preventDefault());
    document.body.append(anchor);
    const pushed = vi.spyOn(history, 'pushState');
    stop = startRouter(window);
    const cancelNative = (event: Event): void => event.preventDefault();
    document.addEventListener('click', cancelNative);

    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...options }));
    document.removeEventListener('click', cancelNative);

    expect(pushed).not.toHaveBeenCalled();
    expect(currentPath.value).toBe('/');
  });

  it('removes both listeners when its owner stops it', () => {
    const anchor = document.createElement('a');
    anchor.href = '/services/example';
    document.body.append(anchor);
    stop = startRouter(window);
    stop();
    stop = undefined;
    anchor.addEventListener('click', (event) => event.preventDefault());

    history.pushState({}, '', '/services');
    window.dispatchEvent(new PopStateEvent('popstate'));
    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, cancelable: true }));

    expect(currentPath.value).toBe('/');
  });
});

describe('safeNext', () => {
  it.each([
    ['/', '/'],
    ['/services/a?b=1', '/services/a?b=1'],
    ['/%5Cevil', '/%5Cevil'],
    ['//evil.example', undefined],
    ['/\\evil', undefined],
    ['/\\\\evil', undefined],
    ['https://evil.example', undefined],
    ['javascript:alert(1)', undefined],
    ['/services/\u0000hidden', undefined],
    ['', undefined],
    [null, undefined],
    [undefined, undefined],
    ['evil', undefined],
    ['/sign-in?next=%2Fservices', undefined],
  ] as const)('reads %j as %j', (raw, expected) => {
    expect(safeNext(raw)).toBe(expected);
  });
});

describe('signInPathFor', () => {
  it('keeps only a safe non-root return path', () => {
    expect(signInPathFor('/')).toBe('/sign-in');
    expect(signInPathFor('//evil.example')).toBe('/sign-in');
    expect(signInPathFor('/admin/users?tab=accounts')).toBe('/sign-in?next=%2Fadmin%2Fusers%3Ftab%3Daccounts');
  });
});
