// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountRecord } from '@holydeck/contracts/accounts';
import { errorEnvelope, successEnvelope } from '@holydeck/contracts/http';

import type { FetchLike, RequestInitLike } from '../api.js';
import { API } from '../api-routes.js';
import { session } from '../app-state.js';
import { setFetching } from '../request.js';
import { offsetOf, RawYamlEditor } from './RawYamlEditor.js';

const YAML = 'titles:\n  tamil: பாடல்\n  romanized: Paadal\nsections: []\n';
const RAW = API.songRaw('song1');

const me: AccountRecord = {
  id: 'a1', name: 'andru', displayName: 'Andru', role: 'admin', createdAt: '2026-09-13T09:30:00.000Z', controlPresentation: true, disabled: false,
};

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });
const yaml = (text: string) => ({ status: 200, json: async (): Promise<unknown> => ({}), text: async (): Promise<string> => text });

let puts: RequestInitLike[];
let putReply: ReturnType<typeof reply>;

beforeEach(() => {
  puts = [];
  putReply = reply(200, successEnvelope({}, 'r'));
  session.value = {
    account: me,
    actor: 'account:a1', permissions: ['content.edit'], startedAt: '2026-09-13T09:30:00.000Z', lastSeenAt: '2026-09-13T09:30:00.000Z',
    expiresAt: '2026-09-14T09:30:00.000Z', rotation: 'authentication', csrf: 'c'.repeat(43), slots: [],
  };
  const fetching: FetchLike = async (url, init) => {
    if (url === RAW && init.method === undefined) return yaml(YAML);
    if (url === RAW && init.method === 'PUT') {
      puts.push(init);
      return putReply;
    }
    throw new Error(`No reply for ${init.method ?? 'GET'} ${url}`);
  };
  setFetching(fetching);
});

describe('offsetOf', () => {
  it('finds a line and column, clamped to the end of the text', () => {
    expect(offsetOf('ab\ncd\n', 2, 2)).toBe(4);
    expect(offsetOf('ab', 1, 9)).toBe(2);
    expect(offsetOf('ab', 4, 1)).toBe(2);
  });
});

describe('RawYamlEditor', () => {
  it('saves the text as plain text and tells the form to re-read', async () => {
    const onSaved = vi.fn();
    const onDirty = vi.fn();
    render(<RawYamlEditor songId="song1" onSaved={onSaved} onDirty={onDirty} />);
    const area = await screen.findByLabelText('Raw YAML') as HTMLTextAreaElement;
    expect(area.value).toBe(YAML);

    fireEvent.input(area, { target: { value: `${YAML}# note\n` } });
    await waitFor(() => expect(onDirty).toHaveBeenLastCalledWith(true));
    fireEvent.click(screen.getByRole('button', { name: 'Validate and Save' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(puts[0]?.body).toBe(`${YAML}# note\n`);
    expect(puts[0]?.headers?.['content-type']).toBe('text/plain');
    await waitFor(() => expect(onDirty).toHaveBeenLastCalledWith(false));
  });

  it('keeps the text on a refusal and puts the cursor at a located problem', async () => {
    putReply = reply(422, errorEnvelope('request.validation_failed', 'Invalid.', 'r', [
      { path: 'sections', code: 'field.invalid', message: 'must be a list', line: 3, column: 5 },
      { path: 'titles', code: 'field.invalid', message: 'is missing' },
    ]));
    render(<RawYamlEditor songId="song1" />);
    const area = await screen.findByLabelText('Raw YAML') as HTMLTextAreaElement;
    fireEvent.input(area, { target: { value: 'broken' } });
    fireEvent.click(screen.getByRole('button', { name: 'Validate and Save' }));

    const located = await screen.findByRole('button', { name: 'Line 3, column 5: must be a list' });
    expect(screen.getByText('Field titles: is missing')).toBeTruthy();
    expect(area.value).toBe('broken');

    fireEvent.input(area, { target: { value: YAML } });
    fireEvent.click(located);
    expect(document.activeElement).toBe(area);
    expect(area.selectionStart).toBe(offsetOf(YAML, 3, 5));
  });

  it('says a newer revision exists on a conflict', async () => {
    putReply = reply(409, errorEnvelope('entity.state_conflict', 'Stale.', 'r'));
    render(<RawYamlEditor songId="song1" />);
    await screen.findByLabelText('Raw YAML');
    fireEvent.click(screen.getByRole('button', { name: 'Validate and Save' }));
    expect(await screen.findByText(/Someone saved a newer version/u)).toBeTruthy();
  });

  it('shows the refusal when the song cannot be read', async () => {
    setFetching(async () => reply(404, errorEnvelope('entity.not_found', 'Gone.', 'r')));
    render(<RawYamlEditor songId="song1" />);
    expect(await screen.findByText('entity.not_found')).toBeTruthy();
  });
});
