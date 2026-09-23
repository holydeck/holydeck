// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/preact';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetWorkspace, service } from '../state/workspace-store.js';
import { setFetching } from '../request.js';
import { AddPanel } from './AddPanel.js';

beforeEach(() => {
  resetWorkspace();
  service.value = {
    id: 's1', title: 'Sunday', date: '2026-09-27', site: 'Main Hall', state: 'upcoming', revision: 'r0',
    sections: [{ id: 'main', name: 'Main', items: [] }],
  };
  setFetching(async () => ({ status: 200, json: async (): Promise<unknown> => ({}) }));
});

const selected = (): string | null => screen.getByRole('tab', { selected: true }).textContent;

describe('AddPanel', () => {
  it('moves focus between tabs with arrows, Home and End, and opens one only on Enter or Space', () => {
    render(<AddPanel />);
    expect(screen.getByRole('searchbox', { name: 'Search content' })).toBeTruthy();
    const bible = screen.getByRole('tab', { name: 'Bible' });
    expect(selected()).toBe('Bible');

    fireEvent.keyDown(bible, { key: 'ArrowRight' });
    expect(document.activeElement?.textContent).toBe('Song');
    expect(selected()).toBe('Bible');

    fireEvent.keyDown(document.activeElement as Element, { key: 'Enter' });
    expect(selected()).toBe('Song');
    expect(document.getElementById('add-panel-song')?.hidden).toBe(false);

    fireEvent.keyDown(document.activeElement as Element, { key: 'End' });
    expect(document.activeElement?.textContent).toBe('Blank Slide');
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toBe('Bible');
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowLeft' });
    expect(document.activeElement?.textContent).toBe('Blank Slide');
    fireEvent.keyDown(document.activeElement as Element, { key: 'Home' });
    expect(document.activeElement?.textContent).toBe('Bible');
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowUp' });
    fireEvent.keyDown(document.activeElement as Element, { key: ' ' });
    expect(selected()).toBe('Blank Slide');
    fireEvent.keyDown(document.activeElement as Element, { key: 'x' });
    expect(selected()).toBe('Blank Slide');
  });

  it('opens a tab on click and offers only the tabs it is given', () => {
    render(<AddPanel tabs={['blank', 'media']} />);
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Blank Slide', 'Media']);
    expect(screen.getByRole('button', { name: 'Insert Blank Slide' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Media' }));
    expect(selected()).toBe('Media');
    fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'grace' } });
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('grace');
  });
});
