// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { successEnvelope } from '@holydeck/contracts/http';
import type { Slide } from '@holydeck/contracts/slide-groups';

import { API } from '../api-routes.js';
import { setFetching } from '../request.js';
import { LanguageBlocks } from './LanguageBlocks.js';

const SLIDE: Slide = {
  id: 's1', enabled: true, label: 'One',
  languageBlocks: [{ id: 'b1', languageKey: 'ta', text: 'வரி' }, { id: 'b2', languageKey: 'ta-Latn', text: 'vari' }],
};

beforeEach(() => {
  setFetching(async () => ({
    status: 200,
    json: async (): Promise<unknown> => successEnvelope([{ stamp: { id: 'k1' }, key: 'ta', displayName: 'Tamil' }], 'r'),
  }));
});

describe('LanguageBlocks', () => {
  it('duplicates and reorders blocks through their own routes, and edits text through the group', async () => {
    const send = vi.fn(async () => undefined);
    const onEdit = vi.fn();
    render(<LanguageBlocks groupId="g" slide={SLIDE} textEditable canEdit onEdit={onEdit} send={send} />);
    const tamil = await screen.findByLabelText('Tamil text') as HTMLTextAreaElement;
    expect(tamil.lang).toBe('ta');
    expect(screen.getByLabelText('ta-Latn text')).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: 'Duplicate' })[1] as HTMLButtonElement);
    expect(send).toHaveBeenLastCalledWith(API.languageBlockDuplicate('g', 's1', 'b2'), { method: 'POST' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Move Down' })[0] as HTMLButtonElement);
    expect(send).toHaveBeenLastCalledWith(API.languageBlockOrder('g', 's1'), { method: 'PUT', body: { blockIds: ['b2', 'b1'] } });

    fireEvent.input(tamil, { target: { value: 'புதிய' } });
    expect(onEdit).toHaveBeenLastCalledWith({ ...SLIDE, languageBlocks: [{ id: 'b1', languageKey: 'ta', text: 'புதிய' }, SLIDE.languageBlocks[1]] });

    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'ta' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Block' }));
    expect(onEdit).toHaveBeenLastCalledWith({ ...SLIDE, languageBlocks: [...SLIDE.languageBlocks, { id: expect.any(String), languageKey: 'ta', text: '' }] });
  });

  it('shows text read-only and offers no new block where the group takes no whole-group save', async () => {
    render(<LanguageBlocks groupId="g" slide={SLIDE} textEditable={false} canEdit={false} onEdit={vi.fn()} send={vi.fn()} />);
    expect(((await screen.findByLabelText('Tamil text')) as HTMLTextAreaElement).readOnly).toBe(true);
    expect(screen.queryByRole('button', { name: 'Add Block' })).toBeNull();
    expect((screen.getAllByRole('button', { name: 'Move Up' })[1] as HTMLButtonElement).disabled).toBe(true);
  });
});
