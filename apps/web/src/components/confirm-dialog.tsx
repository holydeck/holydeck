// The one confirmation dialog every archive, restore and revision restore asks through (UI contract:
// modal dialogs trap focus and close on Escape). `update-dialog.tsx` traps focus on its single action by
// refusing Tab outright; a confirmation has two actions and sometimes a field, so this one wraps Tab from
// its last focusable control to its first and back, and leaves every Tab in between to the browser.
//
// Escape is the Cancel button said from the keyboard, so it is refused exactly when Cancel is disabled —
// while the confirmed change is on its way. Closing hands focus back to whatever held it when the dialog
// opened, which is the row action a person pressed, so a keyboard user is not dropped at the page top.

import { useEffect, useRef } from 'preact/hooks';

import type { ComponentChildren, JSX } from 'preact';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ConfirmDialogProps {
  /** Prefix for the title and body ids the dialog is named and described by. */
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  /** While the confirmed change is in flight: both actions and Escape are refused. */
  readonly busy?: boolean;
  /** Anything said between the body and the actions — a dependents summary, a refusal. */
  readonly children?: ComponentChildren;
}

/** A modal alertdialog with a confirm and a cancel action, focus kept inside it until it closes. */
export function ConfirmDialog({
  id,
  title,
  body,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  busy = false,
  children,
}: ConfirmDialogProps): JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    first.current?.focus();
    return (): void => opener?.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      if (!busy) onCancel();
      return;
    }
    if (event.key !== 'Tab' || box.current === null) return;
    const focusable = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const [head] = focusable;
    const tail = focusable.at(-1);
    if (head === undefined || tail === undefined) {
      event.preventDefault();
      return;
    }
    const target = event.target as HTMLElement;
    if (event.shiftKey && target === head) {
      event.preventDefault();
      tail.focus();
    } else if (!event.shiftKey && target === tail) {
      event.preventDefault();
      head.focus();
    }
  };

  return (
    <div class="modal-backdrop">
      <div
        ref={box}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-body`}
        onKeyDown={onKeyDown}
      >
        <h2 id={`${id}-title`}>{title}</h2>
        <p id={`${id}-body`}>{body}</p>
        {children}
        <button ref={first} type="button" disabled={busy} onClick={onConfirm}>{confirmLabel}</button>
        <button type="button" disabled={busy} onClick={onCancel}>{cancelLabel}</button>
      </div>
    </div>
  );
}
