// A PowerPoint deck imported end to end through the running stack: uploaded as raw bytes, every text
// block reviewed against a seeded slide label, then committed as a new song. What the report and the
// stored song say about where the content came from is asserted from outside, over HTTP only.

import { readFileSync } from 'node:fs';

import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { PPTX_IMPORTS_PATH } from '@holydeck/contracts/pptx';
import { CSRF_HEADER } from '@holydeck/contracts/sessions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signInTo } from '../src/identity.js';
import { startStack } from '../src/stack.js';

import type { SignedIn } from '../src/identity.js';
import type { Stack } from '../src/stack.js';

const PPTX_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const FIXTURE = readFileSync(new URL('../fixtures/sample-presentation.pptx', import.meta.url));

interface Session {
  readonly id: string;
  readonly slides: readonly { readonly textBlocks: readonly string[]; readonly mediaIds: readonly string[] }[];
}

let stack: Stack;
let operator: SignedIn;

beforeAll(async () => {
  stack = await startStack();
  operator = await signInTo(stack.baseUrl);
});

afterAll(async () => {
  await stack.stop();
});

const sending = (path: string, init: { method: string; headers?: Record<string, string>; body?: string | Uint8Array }): Promise<Response> =>
  fetch(`${stack.baseUrl}${path}`, {
    ...init,
    headers: {
      origin: stack.baseUrl,
      [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
      cookie: operator.cookie,
      [CSRF_HEADER]: operator.csrf,
      ...init.headers,
    },
  });

const postingJson = (path: string, body: unknown): Promise<Response> =>
  sending(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('importing a PowerPoint deck', () => {
  it('uploads, reviews and commits a new song that records where it came from', async () => {
    const uploaded = await sending(PPTX_IMPORTS_PATH, {
      method: 'POST',
      headers: { 'content-type': PPTX_TYPE, 'x-file-name': 'sample-presentation.pptx' },
      body: FIXTURE,
    });
    expect(uploaded.status).toBe(201);
    const session = ((await uploaded.json()) as { data: Session }).data;
    expect(session.slides.map((slide) => slide.textBlocks)).toEqual([
      ['அருமை கிருபை', 'Amazing grace'],
      ['Praise the Lord', 'x2'],
      ['Holy holy holy'],
    ]);
    expect(session.slides[2]?.mediaIds).toHaveLength(1);

    const decisions = session.slides.flatMap((slide, slideIndex) =>
      slide.textBlocks.map((_, blockIndex) => ({ slideIndex, blockIndex, label: 'Verse' })),
    );
    const reviewed = await postingJson(`${PPTX_IMPORTS_PATH}/${session.id}/review`, { decisions });
    expect(reviewed.status).toBe(200);

    const committed = await postingJson(`${PPTX_IMPORTS_PATH}/${session.id}/commit`, {
      mode: 'create',
      title: { tamil: 'அருமை கிருபை', romanized: 'Arumai Kirubai' },
      reference: 'sample-presentation.pptx',
    });
    expect(committed.status).toBe(201);
    const { song, report } = ((await committed.json()) as {
      data: {
        song: { body: { provenance: Record<string, unknown> } };
        report: { provenance: Record<string, unknown>; slides: number; blocks: number };
      };
    }).data;
    expect(report.provenance).toEqual({ title: 'Sample Presentation', source: 'HolyDeck Fixtures' });
    expect(report.slides).toBe(3);
    expect(report.blocks).toBe(5);
    expect(song.body.provenance).toMatchObject({ importer: 'powerpoint', reference: 'sample-presentation.pptx' });

    const gone = await sending(`${PPTX_IMPORTS_PATH}/${session.id}`, { method: 'GET' });
    expect(gone.status).toBe(404);
  });
});
