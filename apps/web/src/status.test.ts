// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';

import { say } from './status.js';

describe('saying shell status in the live regions', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="announce-polite" aria-live="polite"></div><div id="announce-assertive" aria-live="assertive"></div>';
  });

  it('writes polite and assertive messages to their own regions', () => {
    expect(say('polite', 'Saved')).toBe(true);
    expect(say('assertive', 'Sign-out failed')).toBe(true);
    expect(document.getElementById('announce-polite')?.textContent).toBe('Saved');
    expect(document.getElementById('announce-assertive')?.textContent).toBe('Sign-out failed');
  });

  it('says a repeated message again rather than leaving it unchanged', () => {
    const writes: (string | null)[] = [];
    let text: string | null = 'Saved';
    const region = {
      get textContent() { return text; },
      set textContent(value: string | null) { writes.push(value); text = value; },
    };
    say('polite', 'Saved', { getElementById: () => region });
    expect(writes).toEqual(['', 'Saved']);
  });

  it('answers false when the shell has no region to say it in yet', () => {
    document.body.innerHTML = '';
    expect(say('polite', 'Saved')).toBe(false);
    expect(say('polite', 'Saved', { getElementById: () => null })).toBe(false);
  });
});
