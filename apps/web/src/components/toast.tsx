// Brief confirmations sit in one polite live stack so an operator can act on them without a page-level
// interruption, while each message independently waits, pauses for attention, and then disappears.

import { signal, type Signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';

import { t } from '../i18n.js';

import type { JSX } from 'preact';

type Toast = {
  readonly id: string;
  readonly message: string;
  readonly action?: { readonly label: string; run(): void };
  readonly durationMs: number;
};

/** The currently visible transient messages, kept reactive for the one mounted toast region. */
export const toasts: Signal<readonly Toast[]> = signal([]);

const dismiss = (id: string): void => {
  toasts.value = toasts.value.filter((toast) => toast.id !== id);
};

/** Adds one transient message, retaining action messages longer so their action remains reachable. */
export function showToast(input: {
  readonly message: string;
  readonly action?: { readonly label: string; run(): void };
  readonly durationMs?: number;
}): void {
  const durationMs = input.durationMs ?? (input.action === undefined ? 4000 : 8000);
  toasts.value = [...toasts.value, { id: globalThis.crypto.randomUUID(), ...input, durationMs }];
}

const isWithin = (element: EventTarget & Node, related: EventTarget | null): boolean =>
  related instanceof Node && element.contains(related);

const ToastItem = ({ toast }: { readonly toast: Toast }): JSX.Element => {
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const remaining = useRef(toast.durationMs);
  const startedAt = useRef(0);

  const clearTimer = (): void => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  };
  const resume = (): void => {
    if (timer.current !== undefined) return;
    startedAt.current = Date.now();
    timer.current = setTimeout(() => dismiss(toast.id), remaining.current);
  };
  const pause = (): void => {
    if (timer.current === undefined) return;
    remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt.current));
    clearTimer();
  };

  useEffect(() => {
    resume();
    return clearTimer;
  }, []);

  return (
    <li
      onFocusIn={pause}
      onFocusOut={(event) => {
        if (!isWithin(event.currentTarget, event.relatedTarget)) resume();
      }}
      onMouseEnter={pause}
      onMouseLeave={resume}
      onKeyDown={(event) => {
        if (event.key === 'Escape') dismiss(toast.id);
      }}
    >
      <span>{toast.message}</span>
      {toast.action === undefined ? null : (
        <button type="button" onClick={() => { toast.action?.run(); dismiss(toast.id); }}>
          {toast.action.label}
        </button>
      )}
      <button type="button" onClick={() => dismiss(toast.id)}>{t('toast.dismiss')}</button>
    </li>
  );
};

/**
 * Renders the single polite stack of transient messages that the application shell mounts once.
 * The region itself is always present, the same way `app-shell.tsx`'s `LiveRegions` are: a region
 * inserted and filled in the same render is often never announced, so only its toasts come and go.
 */
export function ToastRegion(): JSX.Element {
  return <ul aria-live="polite">{toasts.value.map((toast) => <ToastItem key={toast.id} toast={toast} />)}</ul>;
}
