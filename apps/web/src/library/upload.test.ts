// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CSRF_HEADER } from '@holydeck/contracts/sessions';
import { errorEnvelope, successEnvelope } from '@holydeck/contracts/http';

import { NETWORK_UNREACHABLE, UNREADABLE_RESPONSE } from '../api.js';
import { formatBytes, precheck, uploadMedia } from './upload.js';

/** A stand-in for `XMLHttpRequest` that answers with whatever the test sets on `next`. */
class FakeXhr {
  static next: { status: number; body: string } | 'error' = { status: 201, body: '{}' };
  static last: FakeXhr | undefined;
  readonly headers: Record<string, string> = {};
  readonly upload = new EventTarget();
  readonly events = new EventTarget();
  method = '';
  url = '';
  sent: unknown;
  status = 0;
  responseText = '';
  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }
  addEventListener(type: string, listener: EventListener): void {
    this.events.addEventListener(type, listener);
  }
  send(body: unknown): void {
    this.sent = body;
    FakeXhr.last = this;
    const progress = Object.assign(new Event('progress'), { lengthComputable: true, loaded: 5, total: 10 });
    this.upload.dispatchEvent(progress);
    const next = FakeXhr.next;
    if (next === 'error') {
      this.events.dispatchEvent(new Event('error'));
      return;
    }
    this.status = next.status;
    this.responseText = next.body;
    this.events.dispatchEvent(new Event('load'));
  }
}

afterEach(() => vi.unstubAllGlobals());

const png = (size: number): File => new File([new Uint8Array(size)], 'a.png', { type: 'image/png' });

describe('precheck', () => {
  it('refuses an oversize file before sending anything', () => {
    expect(precheck(png(11), 10, ['image/png'])).toBe('too-large');
    expect(precheck(png(10), 10, ['image/png'])).toBe('ok');
  });

  it('refuses a declared type the server does not take, and leaves an untyped file to the server', () => {
    expect(precheck(new File(['x'], 'a.txt', { type: 'text/plain' }), 10, ['image/png'])).toBe('wrong-type');
    expect(precheck(new File(['x'], 'a'), 10, ['image/png'])).toBe('ok');
  });
});

describe('formatBytes', () => {
  it('names the largest unit that keeps the number at one or more', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1_073_741_824)).toBe('1.0 GB');
  });
});

describe('uploadMedia', () => {
  it('reports progress and reads the envelope', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    FakeXhr.next = { status: 201, body: JSON.stringify(successEnvelope({ id: 'm' }, 'r')) };
    const onProgress = vi.fn();
    const answer = await uploadMedia(png(3), onProgress);
    expect(answer.ok && answer.data).toEqual({ id: 'm' });
    expect(onProgress).toHaveBeenCalledWith(5, 10);
    expect(FakeXhr.last?.method).toBe('POST');
    expect(FakeXhr.last?.headers).toHaveProperty(CSRF_HEADER);
    expect((FakeXhr.last?.sent as FormData).get('file')).toBeInstanceOf(File);
  });

  it('reads a refusal, an unreadable body and a lost connection as results', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    FakeXhr.next = { status: 413, body: JSON.stringify(errorEnvelope('media.too_large', 'too big', 'r')) };
    expect(await uploadMedia(png(3), vi.fn())).toMatchObject({ ok: false, code: 'media.too_large' });
    FakeXhr.next = { status: 502, body: '<html>' };
    expect(await uploadMedia(png(3), vi.fn())).toMatchObject({ ok: false, code: UNREADABLE_RESPONSE });
    FakeXhr.next = 'error';
    expect(await uploadMedia(png(3), vi.fn())).toMatchObject({ ok: false, code: NETWORK_UNREACHABLE });
  });
});
