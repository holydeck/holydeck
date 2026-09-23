// Editor changes are retained as small reversible operations here, with reactive availability flags and
// keyboard handling that leaves ordinary text-field undo under the browser's control.

import { computed, signal, type ReadonlySignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';

import type { RefObject } from 'preact';

/** Builds a bounded history of reversible editor operations. */
export function createUndoStack<Op>(limit = 100): {
  push(op: Op): void;
  undo(): Op | undefined;
  redo(): Op | undefined;
  canUndo: ReadonlySignal<boolean>;
  canRedo: ReadonlySignal<boolean>;
  clear(): void;
} {
  const past = signal<readonly Op[]>([]);
  const future = signal<readonly Op[]>([]);
  const canUndo = computed(() => past.value.length > 0);
  const canRedo = computed(() => future.value.length > 0);

  return {
    push(op): void {
      past.value = [...past.value, op].slice(-limit);
      future.value = [];
    },
    undo(): Op | undefined {
      const op = past.value.at(-1);
      if (op === undefined) return undefined;
      past.value = past.value.slice(0, -1);
      future.value = [...future.value, op];
      return op;
    },
    redo(): Op | undefined {
      const op = future.value.at(-1);
      if (op === undefined) return undefined;
      future.value = future.value.slice(0, -1);
      past.value = [...past.value, op];
      return op;
    },
    canUndo,
    canRedo,
    clear(): void {
      past.value = [];
      future.value = [];
    },
  };
}

/** Applies this editor's history shortcuts while focus remains within its workspace. */
export function useUndoKeys<Op>(
  stack: ReturnType<typeof createUndoStack<Op>>,
  apply: (op: Op, direction: 'undo' | 'redo') => void,
  element: RefObject<HTMLElement>,
): void {
  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 'z' || (!event.metaKey && !event.ctrlKey)) return;
      const active = document.activeElement;
      if (
        active === null ||
        active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA' ||
        !element.current?.contains(active)
      ) return;
      const direction = event.shiftKey ? 'redo' : 'undo';
      const op = direction === 'undo' ? stack.undo() : stack.redo();
      if (op === undefined) return;
      apply(op, direction);
      event.preventDefault();
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [stack, apply, element]);
}
