// Code-splitting for surfaces only some routes reach (roadmap D2), without `preact/compat`.
//
// `preact/compat`'s `lazy` needs `Suspense` and the rest of the React compatibility layer, which would
// cost the entry chunk more than the pages it keeps out of it. This is the one piece of it the client
// uses: a component that asks esbuild's split chunk for the real one on first render, shows the shell's
// loading line meanwhile, and renders the real one with the same props once it arrives. The dynamic
// `import()` a caller passes is what makes esbuild cut the chunk; this module only waits for it.

import { useEffect, useState } from 'preact/hooks';

import { t } from './i18n.js';

import type { ComponentType, JSX } from 'preact';

/** What a chunk's loader answers: the module's page component, taken off whichever export holds it. */
export type PageLoader<P> = () => Promise<ComponentType<P>>;

/**
 * A component that renders the one `load` resolves to. The loader runs once per `lazy` call, not once per
 * render, so navigating away and back never asks for the chunk twice. A chunk that cannot be fetched —
 * the network went while the page was open, and the service worker had not cached it yet — shows the
 * error line rather than a loading line that would never end.
 */
export function lazy<P extends object>(load: PageLoader<P>): (props: P) => JSX.Element {
  let loaded: ComponentType<P> | undefined;
  let pending: Promise<ComponentType<P>> | undefined;

  return function LazyPage(props: P): JSX.Element {
    const [, setReady] = useState(0);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
      if (loaded !== undefined) return;
      let current = true;
      pending ??= load();
      pending.then(
        (component) => {
          loaded = component;
          if (current) setReady((count) => count + 1);
        },
        () => {
          // Forgotten so a later render asks again: the network may be back by then.
          pending = undefined;
          if (current) setFailed(true);
        },
      );
      return () => {
        current = false;
      };
    }, []);

    if (loaded !== undefined) {
      const Page = loaded;
      return <Page {...props} />;
    }
    return <p role="status">{failed ? t('form.error.network') : t('app.loading')}</p>;
  };
}
