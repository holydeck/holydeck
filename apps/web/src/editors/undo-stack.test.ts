// @vitest-environment happy-dom
// The operation history stays independent of any one editor, while its shortcut test proves the document
// listener acts only for focused workspace content and leaves the stack's reactive flags to the signal tests.

import { fireEvent, render } from '@testing-library/preact';
import { h } from 'preact';
import { useRef } from 'preact/hooks';
import { describe, expect, it, vi } from 'vitest';

import { createUndoStack, useUndoKeys } from './undo-stack.js';

describe('createUndoStack', () => {
  it('undoes, redoes, and drops redo on a new push', () => {
    const stack = createUndoStack<string>();
    stack.push('a'); stack.push('b');
    expect(stack.undo()).toBe('b');
    expect(stack.redo()).toBe('b');
    stack.undo(); stack.push('c');
    expect(stack.canRedo.value).toBe(false);
  });

  it('keeps at most limit entries', () => {
    const stack = createUndoStack<string>(2);
    stack.push('a'); stack.push('b'); stack.push('c');
    expect(stack.undo()).toBe('c');
    expect(stack.undo()).toBe('b');
    expect(stack.undo()).toBeUndefined();
  });
});

it('applies undo only while the workspace has focus', () => {
  const stack = createUndoStack<string>();
  const apply = vi.fn();
  stack.push('rename');
  const Workspace = () => {
    const element = useRef<HTMLElement>(null);
    useUndoKeys(stack, apply, element);
    return h('div', { ref: element, tabIndex: -1 });
  };

  const view = render(h(Workspace, {}));
  const workspace = view.container.firstElementChild as HTMLElement;
  workspace.focus();
  fireEvent.keyDown(document, { key: 'z', ctrlKey: true });

  expect(apply).toHaveBeenCalledWith('rename', 'undo');
});
