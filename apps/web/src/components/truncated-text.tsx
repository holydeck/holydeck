// Ellipsis is useful only when it does not make the rest of a label unreachable. This component keeps
// the complete text in the document and pairs it with an always-visible localized disclosure, so touch,
// keyboard and pointer users all use the same control instead of relying on a hover-only title tooltip.

import { useState } from 'preact/hooks';

import { t } from '../i18n.js';

import type { JSX } from 'preact';

/** Compact text with an in-place control that reveals and collapses its complete value. */
export function TruncatedText({ text }: { readonly text: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const contentClass = expanded
    ? 'truncated-text-content truncated-text-content-expanded'
    : 'truncated-text-content';

  return (
    <span class="truncated-text">
      <span class={contentClass}>{text}</span>
      <button
        class="truncated-text-toggle"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((shown) => !shown)}
      >
        {t(expanded ? 'truncatedText.hide' : 'truncatedText.show')}
      </button>
    </span>
  );
}
