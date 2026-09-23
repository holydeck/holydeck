// @vitest-environment happy-dom

import { act, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountRecord } from '@holydeck/contracts/accounts';
import { errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import type { CustomSlideBody, CustomSlideBox, ServiceItem } from '@holydeck/contracts/services';

import type { FetchLike } from '../api.js';
import { API } from '../api-routes.js';
import { session } from '../app-state.js';
import { toasts } from '../components/toast.js';
import { setFetching } from '../request.js';
import { resetWorkspace, service } from '../state/workspace-store.js';
import type { ServiceView } from '../workspace/service-data.js';
import { BoxProperties } from './BoxProperties.js';
import { activeCanvas, CustomSlideCanvas } from './CustomSlideCanvas.js';

const intrinsic = vi.hoisted(() => vi.fn(async () => ({ width: 1280, height: 720 })));
vi.mock('../preview/media-size.js', () => ({ intrinsicSizeOf: intrinsic }));

const me: AccountRecord = {
  id: 'GLkQ5wEtQEy5PfN2Zr9m7A', name: 'andru', displayName: 'Andru Example', role: 'admin',
  createdAt: '2026-09-13T09:30:00.000Z', controlPresentation: true, disabled: false,
};

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });

const TEXT: CustomSlideBox = {
  id: 't1', kind: 'text', layer: 0, text: 'Welcome to our service today', frame: { x: 0.1, y: 0.1, width: 0.5, height: 0.2 },
  style: { fontFamily: 'var(--font-latin)', fontWeight: 400, sizeRatio: 0.05, lineHeight: 1.2, align: 'center', verticalAlign: 'center' },
};
const MEDIA: CustomSlideBox = {
  id: 'b2', kind: 'media', layer: 1, mediaId: 'm1', mediaKind: 'image', fit: 'contain',
  frame: { x: 0.6, y: 0.6, width: 0.3, height: 0.3 }, intrinsicSize: { width: 800, height: 600 },
};
const DERIVED = { kind: 'thumbnail', bytes: 1, hash: 'h', from: 'h' };
const slide = (...boxes: CustomSlideBox[]): CustomSlideBody => ({ kind: 'custom-slide', boxes });

const viewWith = (body: CustomSlideBody, state: ServiceView['state'] = 'upcoming'): ServiceView => {
  const item: ServiceItem = { id: 'c', kind: 'custom-slide', title: 'Welcome', enabled: true, content: undefined, body };
  return {
    id: 's1', title: 'Sunday', date: '2026-09-27', site: 'Main Hall', state, revision: 'r0',
    sections: [{ id: 'main', name: 'Main', items: [item] }],
  };
};

const asRecord = (view: ServiceView) => {
  const { id, revision, ...rest } = view;
  return { stamp: { id, updatedAt: revision }, ...rest };
};

const BODY = `PUT ${API.itemAction('s1', 'c', 'body')}`;
let puts: CustomSlideBody[];
let extra: Record<string, ReturnType<typeof reply>>;

const signIn = (permissions: string[]): void => {
  session.value = {
    account: me, actor: `account:${me.id}`, permissions,
    startedAt: '2026-09-13T09:30:00.000Z', lastSeenAt: '2026-09-13T09:30:00.000Z',
    expiresAt: '2026-09-14T09:30:00.000Z', rotation: 'authentication', csrf: 'c'.repeat(43), slots: [],
  };
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  resetWorkspace();
  toasts.value = [];
  puts = [];
  extra = {};
  signIn(['services.manage']);
  service.value = viewWith(slide(TEXT, MEDIA));
  const fetching: FetchLike = async (url, init) => {
    const key = `${init.method ?? 'GET'} ${url}`;
    if (key === BODY) {
      const body = JSON.parse(String(init.body)) as CustomSlideBody;
      puts.push(body);
      return reply(200, successEnvelope(asRecord(viewWith(body)), 'r'));
    }
    if (key.endsWith('/content-drift')) return reply(200, successEnvelope([], 'r'));
    const answer = extra[key];
    if (answer !== undefined) return answer;
    throw new Error(`No reply for ${key}`);
  };
  setFetching(fetching);
});

afterEach(() => {
  vi.useRealTimers();
});

const settle = (ms = 0): Promise<void> => act(async () => {
  await vi.advanceTimersByTimeAsync(ms);
});

const openCanvas = async (): Promise<ReturnType<typeof render>> => {
  const rendered = render(<><CustomSlideCanvas itemId="c" /><BoxProperties /></>);
  await settle();
  return rendered;
};

const textBox = (): HTMLElement => screen.getByRole('button', { name: /^Text box: Welcome/u });
const select = async (box: HTMLElement): Promise<void> => {
  box.focus();
  await settle();
};
const boxIn = (body: CustomSlideBody | undefined, id: string): CustomSlideBox | undefined => body?.boxes.find((box) => box.id === id);

describe('CustomSlideCanvas', () => {
  it('moves a box with arrows, undoes with Ctrl+Z, and saves each as one write', async () => {
    await openCanvas();
    const box = textBox();
    expect(box.getAttribute('aria-label')).toBe('Text box: Welcome to our service');
    await select(box);
    expect(box.getAttribute('aria-pressed')).toBe('true');

    fireEvent.keyDown(box, { key: 'ArrowRight', shiftKey: true });
    await settle(800);
    expect(puts).toHaveLength(1);
    // 16 px on a canvas drawn 960 px wide (1920 at the initial 50% zoom).
    expect(boxIn(puts[0], 't1')?.frame.x).toBeCloseTo(0.1 + 16 / 960, 12);

    fireEvent.keyDown(document, { key: 'z', ctrlKey: true });
    await settle(800);
    expect(puts).toHaveLength(2);
    expect(boxIn(puts[1], 't1')?.frame.x).toBe(0.1);
    expect(toasts.value.at(-1)?.message).toBe('Undid: move');

    fireEvent.keyDown(document, { key: 'z', ctrlKey: true, shiftKey: true });
    await settle(800);
    expect(puts).toHaveLength(3);
    expect(toasts.value.at(-1)?.message).toBe('Redid: move');

    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'ArrowLeft' });
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    await settle(800);
    expect(puts).toHaveLength(4);
  });

  it('edits x/y/width/height numerically and clamps inside the slide', async () => {
    await openCanvas();
    expect(screen.queryByRole('group', { name: 'Selected box' })).toBeNull();
    await select(textBox());

    const x = screen.getByLabelText('X (%)') as HTMLInputElement;
    expect(x.value).toBe('10');
    fireEvent.change(x, { target: { value: '95' } });
    expect(x.value).toBe('50');
    fireEvent.change(screen.getByLabelText('Height (%)'), { target: { value: '150' } });
    expect((screen.getByLabelText('Height (%)') as HTMLInputElement).value).toBe('100');
    expect((screen.getByLabelText('Y (%)') as HTMLInputElement).value).toBe('0');
    fireEvent.change(screen.getByLabelText('Width (%)'), { target: { value: 'nope' } });
    expect((screen.getByLabelText('Width (%)') as HTMLInputElement).value).toBe('50');

    await settle(800);
    expect(puts).toHaveLength(1);
    expect(boxIn(puts[0], 't1')?.frame).toEqual({ x: 0.5, y: 0, width: 0.5, height: 1 });
  });

  it('changes layer, size, weight and alignment from the properties, each undoable', async () => {
    await openCanvas();
    await select(textBox());
    fireEvent.change(screen.getByLabelText('Layer'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Layer'), { target: { value: '-1' } });
    fireEvent.change(screen.getByLabelText('Font size (% of height)'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Font size (% of height)'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Weight'), { target: { value: '700' } });
    fireEvent.change(screen.getByLabelText('Alignment'), { target: { value: 'end' } });
    await settle(800);
    const saved = boxIn(puts.at(-1), 't1');
    expect(saved).toMatchObject({ layer: 5, style: { sizeRatio: 0.1, fontWeight: 700, align: 'end' } });

    textBox().focus();
    fireEvent.keyDown(document, { key: 'z', metaKey: true });
    expect(toasts.value.at(-1)?.message).toBe('Undid: style change');
  });

  it('Fit to View and zoom controls change the zoom readout', async () => {
    const { container } = await openCanvas();
    expect(screen.getByText('Zoom 50%')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom In' }));
    expect(screen.getByText('Zoom 75%')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom Out' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom Out' }));
    expect(screen.getByText('Zoom 25%')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Zoom Out' }) as HTMLButtonElement).disabled).toBe(true);
    for (let step = 0; step < 16; step += 1) fireEvent.click(screen.getByRole('button', { name: 'Zoom In' }));
    expect(screen.getByText('Zoom 400%')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Zoom In' }) as HTMLButtonElement).disabled).toBe(true);

    Object.defineProperty(container.querySelector('.canvas-viewport'), 'clientWidth', { value: 1440 });
    fireEvent.click(screen.getByRole('button', { name: 'Fit to View' }));
    expect(screen.getByText('Zoom 75%')).toBeTruthy();
    expect((container.querySelector('.canvas-slide') as HTMLElement).style.width).toBe('1440px');
  });

  it('offers the four fit modes for a media box', async () => {
    await openCanvas();
    await select(screen.getByRole('button', { name: 'Media box: m1' }));
    const fit = screen.getByLabelText('Fit') as HTMLSelectElement;
    expect([...fit.options].map((option) => option.textContent)).toEqual(['Original size', 'Contain', 'Cover', 'Stretch']);
    fireEvent.change(fit, { target: { value: 'cover' } });
    await settle(800);
    expect(boxIn(puts[0], 'b2')).toMatchObject({ fit: 'cover' });
    expect(screen.queryByLabelText('Weight')).toBeNull();
  });

  it('is not editable when read-only', async () => {
    service.value = viewWith(slide(TEXT, MEDIA), 'completed');
    await openCanvas();
    expect(screen.queryByRole('toolbar')).toBeNull();
    const box = textBox();
    expect(box.getAttribute('aria-disabled')).toBe('true');
    await select(box);
    fireEvent.keyDown(box, { key: 'ArrowRight' });
    fireEvent.keyDown(box, { key: 'Delete' });
    fireEvent.pointerDown(box, { clientX: 0, clientY: 0 });
    fireEvent.pointerUp(window, { clientX: 50, clientY: 0 });
    expect((screen.getByLabelText('X (%)') as HTMLInputElement).disabled).toBe(true);
    expect(activeCanvas.value?.change('canvas.op.move', { frame: { x: 0, y: 0, width: 1, height: 1 } })?.frame.x).toBe(0.1);
    await settle(1000);
    expect(puts).toEqual([]);
    expect(screen.getByText('Zoom 50%')).toBeTruthy();
  });

  it('adds, duplicates, relayers and removes boxes, and Undo in the toast brings a box back', async () => {
    await openCanvas();
    fireEvent.click(screen.getByRole('button', { name: 'Add Text' }));
    expect(screen.getByRole('button', { name: 'Text box: New text' }).getAttribute('aria-pressed')).toBe('true');
    await settle(800);
    expect(puts[0]?.boxes).toHaveLength(3);
    expect(puts[0]?.boxes[2]).toMatchObject({ kind: 'text', text: 'New text', layer: 2 });

    await select(textBox());
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    const copy = screen.getAllByRole('button', { name: /^Text box: Welcome/u })[1] as HTMLElement;
    expect(copy.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Send Backward' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bring Forward' }));
    await settle(800);
    expect(puts.at(-1)?.boxes).toHaveLength(4);

    fireEvent.keyDown(copy, { key: 'Delete' });
    expect(screen.queryAllByRole('button', { name: /^Text box: Welcome/u })).toHaveLength(1);
    const toast = toasts.value.at(-1);
    expect(toast?.message).toBe('Box removed.');
    act(() => toast?.action?.run());
    expect(screen.getAllByRole('button', { name: /^Text box: Welcome/u })).toHaveLength(2);
    expect(toasts.value.at(-1)?.message).toBe('Undid: remove box');

    await select(screen.getByRole('button', { name: 'Media box: m1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.queryByRole('button', { name: 'Media box: m1' })).toBeNull();
    const stale = toasts.value.at(-1);
    fireEvent.click(screen.getByRole('button', { name: 'Add Text' }));
    act(() => stale?.action?.run());
    expect(screen.queryByRole('button', { name: 'Media box: m1' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Text box: New text' })).toHaveLength(2);
    (screen.getAllByRole('button', { name: /^Text box: Welcome/u })[0] as HTMLElement).focus();
    fireEvent.keyDown(document, { key: 'z', ctrlKey: true });
    expect(screen.getAllByRole('button', { name: 'Text box: New text' })).toHaveLength(1);
  });

  it('keeps Add Media off without content.edit, and stores the intrinsic size of picked media', async () => {
    const { unmount } = await openCanvas();
    expect((screen.getByRole('button', { name: 'Add Media' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Media can be added once the media list is available to you.')).toBeTruthy();
    unmount();

    signIn(['services.manage', 'content.edit']);
    extra[`GET ${API.mediaUpload}`] = reply(200, successEnvelope([
      { stamp: { id: 'x' }, manifest: { id: 'img1', bytes: 1, hash: 'h', type: 'image/png', processingState: 'ready', derivatives: [DERIVED] } },
      { stamp: { id: 'y' }, manifest: { id: 'vid1', bytes: 1, hash: 'h', type: 'video/mp4', processingState: 'ready', derivatives: [DERIVED] } },
      { stamp: { id: 'z' }, manifest: { id: 'bad', bytes: 1, hash: 'h', type: 'image/png', processingState: 'failed', derivatives: [] } },
      { stamp: { id: 'w' }, manifest: { id: 'doc', bytes: 1, hash: 'h', type: 'application/pdf', processingState: 'ready', derivatives: [DERIVED] } },
    ], 'r'));
    await openCanvas();
    fireEvent.click(screen.getByRole('button', { name: 'Add Media' }));
    expect(screen.getByText('Loading…')).toBeTruthy();
    await settle();
    expect(screen.getByRole('option', { name: /img1.*Ready/u }).getAttribute('aria-disabled')).toBe('false');
    expect(screen.getByRole('option', { name: /bad.*Failed/u }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('option', { name: /doc/u }).getAttribute('aria-disabled')).toBe('true');

    fireEvent.click(screen.getByRole('option', { name: /vid1/u }));
    await settle();
    await settle(800);
    expect(intrinsic).toHaveBeenCalledWith('vid1', 'video');
    expect(puts[0]?.boxes.at(-1)).toMatchObject({ kind: 'media', mediaId: 'vid1', mediaKind: 'video', fit: 'contain', intrinsicSize: { width: 1280, height: 720 } });
    expect(screen.getByRole('button', { name: 'Media box: vid1' })).toBeTruthy();

    intrinsic.mockRejectedValueOnce(new Error('broken'));
    fireEvent.click(screen.getByRole('button', { name: 'Add Media' }));
    await settle();
    fireEvent.click(screen.getByRole('option', { name: /img1/u }));
    await settle();
    expect(screen.getByText('media.unreadable')).toBeTruthy();
  });

  it('reports a media list that cannot be read, and one that is empty', async () => {
    signIn(['services.manage', 'content.edit']);
    extra[`GET ${API.mediaUpload}`] = reply(403, errorEnvelope('auth.forbidden', 'No.', 'r'));
    const { unmount } = await openCanvas();
    fireEvent.click(screen.getByRole('button', { name: 'Add Media' }));
    await settle();
    expect(screen.getByText('auth.forbidden')).toBeTruthy();
    unmount();

    extra[`GET ${API.mediaUpload}`] = reply(200, successEnvelope({ not: 'a list' }, 'r'));
    const second = await openCanvas();
    fireEvent.click(screen.getByRole('button', { name: 'Add Media' }));
    await settle();
    expect(screen.getByRole('alert').textContent).toContain('We couldn');
    second.unmount();

    extra[`GET ${API.mediaUpload}`] = reply(200, successEnvelope([], 'r'));
    await openCanvas();
    fireEvent.click(screen.getByRole('button', { name: 'Add Media' }));
    await settle();
    expect(screen.getByText('No media yet.')).toBeTruthy();
  });

  it('drags to move and to resize, each as one step', async () => {
    const { container } = await openCanvas();
    const box = textBox();
    fireEvent.pointerDown(box, { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 196, clientY: 100 });
    expect(box.style.left).toBe(`${(0.1 + 96 / 960) * 100}%`);
    fireEvent.pointerUp(window, { clientX: 196, clientY: 100 });
    await settle(800);
    expect(puts).toHaveLength(1);
    expect(boxIn(puts[0], 't1')?.frame.x).toBeCloseTo(0.2, 12);

    const handle = container.querySelector('.canvas-handle-se') as HTMLElement;
    fireEvent.pointerDown(handle, { clientX: 0, clientY: 0 });
    fireEvent.pointerUp(window, { clientX: 96, clientY: 54 });
    await settle(800);
    expect(boxIn(puts[1], 't1')?.frame.width).toBeCloseTo(0.6, 12);
    expect(boxIn(puts[1], 't1')?.frame.height).toBeCloseTo(0.3, 12);

    fireEvent.pointerDown(container.querySelector('.canvas-slide') as HTMLElement);
    expect(textBox().getAttribute('aria-pressed')).toBe('false');
  });

  it('edits text inline on Enter or double-click, and Escape keeps the old text', async () => {
    await openCanvas();
    await select(textBox());
    fireEvent.keyDown(textBox(), { key: 'Enter' });
    const field = screen.getByLabelText('Edit text') as HTMLTextAreaElement;
    expect(document.activeElement).toBe(field);
    field.value = 'Discarded';
    fireEvent.keyDown(field, { key: 'Escape' });
    fireEvent.blur(field);
    expect(textBox()).toBeTruthy();
    expect(screen.queryByLabelText('Edit text')).toBeNull();

    fireEvent.dblClick(textBox());
    const again = screen.getByLabelText('Edit text') as HTMLTextAreaElement;
    again.value = 'Good morning church';
    fireEvent.blur(again);
    expect(screen.getByRole('button', { name: 'Text box: Good morning church' })).toBeTruthy();

    fireEvent.dblClick(screen.getByRole('button', { name: 'Text box: Good morning church' }));
    const empty = screen.getByLabelText('Edit text') as HTMLTextAreaElement;
    empty.value = '   ';
    fireEvent.blur(empty);
    await settle(800);
    expect(puts).toHaveLength(1);
    expect(boxIn(puts[0], 't1')).toMatchObject({ text: 'Good morning church' });
  });

  it('Save Checkpoint saves at once, and the canvas renders nothing for another kind', async () => {
    await openCanvas();
    await select(textBox());
    fireEvent.keyDown(textBox(), { key: 'ArrowRight' });
    fireEvent.click(screen.getByRole('button', { name: 'Save Checkpoint' }));
    await settle();
    expect(puts).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toBe('Saved');

    service.value = { ...viewWith(slide()), sections: [{ id: 'main', name: 'Main', items: [{ id: 'r', kind: 'reading', title: 'R', enabled: true, content: undefined }] }] };
    const { container } = render(<CustomSlideCanvas itemId="r" />);
    expect(container.innerHTML).toBe('');
  });
});
