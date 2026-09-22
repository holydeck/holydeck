// What any path the router has no route for renders. The server already answered it with the shell (the
// SPA fallback cannot know the client's routes), so saying "not found" is this page's job.

import { t } from '../i18n.js';

import type { JSX } from 'preact';

/** The not-found view, with a way back to somewhere that exists. */
export function NotFoundPage(): JSX.Element {
  return (
    <>
      <h1>{t('app.notFound.title')}</h1>
      <p>{t('app.notFound.body')}</p>
      <p><a href="/services">{t('app.notFound.link')}</a></p>
    </>
  );
}
