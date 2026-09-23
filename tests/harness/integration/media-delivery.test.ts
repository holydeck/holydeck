import { createHash } from 'node:crypto';

import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { CSRF_HEADER } from '@holydeck/contracts/sessions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OPERATOR, signInTo } from '../src/identity.js';
import { startStack } from '../src/stack.js';

import type { SignedIn } from '../src/identity.js';
import type { Stack } from '../src/stack.js';

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x04,
]);
const CLIENT = { [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current) };

let stack: Stack;
let operator: SignedIn;

beforeAll(async () => {
  stack = await startStack();
  operator = await signInTo(stack.baseUrl);
});

afterAll(async () => {
  await stack.stop();
});

describe('media byte delivery', () => {
  it('streams an uploaded asset whole and by byte range', async () => {
    const form = new FormData();
    form.set('file', new Blob([PNG], { type: 'image/png' }), `${OPERATOR.name}.png`);
    const upload = await fetch(`${stack.baseUrl}/api/v1/media`, {
      method: 'POST',
      headers: {
        ...CLIENT,
        origin: stack.baseUrl,
        cookie: operator.cookie,
        [CSRF_HEADER]: operator.csrf,
      },
      body: form,
    });
    expect(upload.status).toBe(201);
    const record = (await upload.json()) as { data: { stamp: { id: string }; manifest: { hash: string } } };
    const url = `${stack.baseUrl}/api/v1/media/${record.data.stamp.id}/content`;

    const whole = await fetch(url, { headers: { ...CLIENT, cookie: operator.cookie } });
    expect(whole.status).toBe(200);
    const body = new Uint8Array(await whole.arrayBuffer());
    expect(`sha256:${createHash('sha256').update(body).digest('hex')}`).toBe(record.data.manifest.hash);

    const partial = await fetch(url, {
      headers: { ...CLIENT, cookie: operator.cookie, range: 'bytes=0-7' },
    });
    expect(partial.status).toBe(206);
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(PNG.subarray(0, 8));
  });
});
