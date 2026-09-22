// The surface an output window shows (`/output/:kind`). Specs 05-07 draw the audience, stage and singer
// outputs here; until then it is an empty, full-window surface that names its kind for them to key on.
// It lives in its own chunk so an output window, which never edits, never downloads editor code.

import type { JSX } from 'preact';

/** An output window's surface, empty until its spec fills it. */
export function OutputPage({ kind }: { readonly kind: string }): JSX.Element {
  return <div class="output-surface" data-output-kind={kind}></div>;
}

export default OutputPage;
