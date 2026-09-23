// @vitest-environment happy-dom

import { render, screen } from '@testing-library/preact';
import { describe, expect, it } from 'vitest';

import { successEnvelope } from '@holydeck/contracts/http';

import { setFetching } from '../request.js';
import { ContentCompare, readHistory } from './ContentCompare.js';

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });

describe('readHistory', () => {
  it('reads a sermon by its first language’s points and a slide group by its slides', () => {
    expect(readHistory('sermon', [{ title: 'Hope', revision: 1, body: { languages: { en: { points: ['One', 2, 'Two'] } } } }]))
      .toEqual([{ revision: 1, title: 'Hope', labels: ['One', 'Two'] }]);
    expect(readHistory('sermon', [{ title: 'Hope', revision: 1, body: { languages: {} } }]))
      .toEqual([{ revision: 1, title: 'Hope', labels: [] }]);
    expect(readHistory('slideGroup', [{ title: 'G', body: { slides: [{ label: 'Intro' }, { nope: 1 }] } }, { title: 'G2', body: null }]))
      .toEqual([{ revision: 1, title: 'G', labels: ['Intro'] }, { revision: 2, title: 'G2', labels: [] }]);
    expect(readHistory('song', [{ title: 'S', revision: 1, body: { sections: 'x' } }])).toEqual([{ revision: 1, title: 'S', labels: [] }]);
  });

  it('refuses an answer that is not a history', () => {
    expect(readHistory('song', { nope: true })).toBeUndefined();
    expect(readHistory('song', [{ revision: 1 }])).toBeUndefined();
    expect(readHistory('song', [null])).toBeUndefined();
  });
});

describe('ContentCompare', () => {
  it('marks a revision the history does not hold, and a revision with no parts', async () => {
    setFetching(async () => reply(200, successEnvelope([{ title: 'G', body: { slides: [] } }], 'r')));
    render(<ContentCompare kind="slideGroup" contentId="g/1" pinned={1} latest={4} />);
    expect(await screen.findByRole('cell', { name: 'G' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: 'None' })).toBeTruthy();
    expect(screen.getAllByRole('cell', { name: 'Not in history' })).toHaveLength(2);
  });
});
