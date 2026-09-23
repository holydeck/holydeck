import { writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { RESOLVE_TOOL_NAME } from './anthropic.js';
import { HolyDeckError } from './messages.js';
import { parseSermonFile } from './sermon.js';
import {
  buildSermonYaml,
  generateSermonFromText,
  parsePastorMessage,
  resolveSermonFilename,
  slugifyTitle,
  upcomingSunday,
} from './sermon-ai.js';
import type { HttpPost } from './anthropic.js';
import type { IntegrationCallInfo } from './sermon-ai.js';

// Every write the pipeline could reach for, replaced by a recorder that also refuses. The contract is
// that the returned object is the whole preview: a file appears only once something downstream is told
// to write one, and nothing in core is.
const { fsWrites } = vi.hoisted(() => ({ fsWrites: [] as string[] }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const refuse = (name: string) => () => {
    fsWrites.push(name);
    throw new Error(`the sermon pipeline must not write to the filesystem (called ${name})`);
  };
  return {
    ...actual,
    appendFile: refuse('appendFile'),
    mkdir: refuse('mkdir'),
    open: refuse('open'),
    rename: refuse('rename'),
    rm: refuse('rm'),
    writeFile: refuse('writeFile'),
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const refuse = (name: string) => () => {
    fsWrites.push(name);
    throw new Error(`the sermon pipeline must not write to the filesystem (called ${name})`);
  };
  return {
    ...actual,
    appendFileSync: refuse('appendFileSync'),
    createWriteStream: refuse('createWriteStream'),
    mkdirSync: refuse('mkdirSync'),
    openSync: refuse('openSync'),
    renameSync: refuse('renameSync'),
    rmSync: refuse('rmSync'),
    writeFileSync: refuse('writeFileSync'),
  };
});

/** A week's message as a pastor sends it: a title line with a lead-in, then one passage per line. */
const MESSAGE = [
  "Today's Sermon. GOD BREAK THE YOKE",
  'Leviticus 26:13',
  'Psalm 118:24',
  '2 Samuel 1:6',
  '1 Corinthians 13:4-7',
  '1. Mose 30:34,35',
  'Psalm 118:24',
  'Hosea 4:6',
].join('\n');

const TRANSLATIONS = ['SCH2000', 'TAOVBSI'];

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(HolyDeckError);
    return (error as HolyDeckError).code;
  }
  throw new Error('expected the call to throw');
}

describe('parsePastorMessage', () => {
  it('keeps every passage in message order, duplicates included, with its verse list compact', () => {
    expect(parsePastorMessage(MESSAGE)).toEqual({
      title: 'GOD BREAK THE YOKE',
      lines: [
        { rawBook: 'Leviticus', chapter: 26, verseListRaw: '13' },
        { rawBook: 'Psalm', chapter: 118, verseListRaw: '24' },
        { rawBook: '2 Samuel', chapter: 1, verseListRaw: '6' },
        { rawBook: '1 Corinthians', chapter: 13, verseListRaw: '4-7' },
        { rawBook: '1. Mose', chapter: 30, verseListRaw: '34,35' },
        { rawBook: 'Psalm', chapter: 118, verseListRaw: '24' },
        { rawBook: 'Hosea', chapter: 4, verseListRaw: '6' },
      ],
    });
  });

  it('keeps a book token it cannot place, so nothing parsed is thrown away', () => {
    const message = parsePastorMessage('Roman 7:15\nHosea 4:6');
    expect(message.lines.map((line) => line.rawBook)).toEqual(['Roman', 'Hosea']);
    expect(message.title).toBeUndefined();
  });

  it('tidies the spacing inside a verse part without regrouping the commas the pastor wrote', () => {
    const lines = parsePastorMessage(
      ['Genesis 30: 34 , 35', '1 Corinthians 13: 4 - 7', 'Psalm 118: 07'].join('\n'),
    ).lines;
    expect(lines.map((line) => line.verseListRaw)).toEqual(['34,35', '4-7', '7']);
  });

  it('strips a list marker and trailing punctuation from a passage line', () => {
    expect(parsePastorMessage('- Leviticus 26:13.\n• Hosea 4:6,').lines).toEqual([
      { rawBook: 'Leviticus', chapter: 26, verseListRaw: '13' },
      { rawBook: 'Hosea', chapter: 4, verseListRaw: '6' },
    ]);
  });

  it.each([
    ['a colon lead-in', 'Sermon: The Good Shepherd', 'The Good Shepherd'],
    ['no lead-in at all', 'GOD BREAK THE YOKE', 'GOD BREAK THE YOKE'],
    ['a lead-in before a title that ends in a period', "Today's word. Break the yoke.", 'Break the yoke.'],
    ['a chapter number in front of the colon', 'Psalm 23: The Lord is my shepherd', 'The Lord is my shepherd'],
    ['a count leading the words after the colon', 'Matthew 5: 8 beatitudes for us', '8 beatitudes for us'],
  ])('reads the title out of a first line with %s', (_case, first, title) => {
    expect(parsePastorMessage(`${first}\nHosea 4:6`).title).toBe(title);
  });

  it('reports a passage whose verse list it cannot read instead of reading the line as a title', () => {
    const message = parsePastorMessage('Hosea 4:9-2\nHosea 4:6');
    expect(message.title).toBeUndefined();
    expect(message.lines).toEqual([{ rawBook: 'Hosea', chapter: 4, verseListRaw: '6' }]);
    expect(message.notices).toEqual([expect.stringContaining('Hosea 4:9-2')]);
  });

  it('takes only the first prose line as the title and ignores the rest', () => {
    const message = parsePastorMessage('GOD BREAK THE YOKE\nHosea 4:6\nSee you Sunday!');
    expect(message.title).toBe('GOD BREAK THE YOKE');
    expect(message.lines).toHaveLength(1);
  });

  it.each([
    ['nothing at all', '   \n\n'],
    ['prose only', 'See you on Sunday, everyone!'],
    ['a chapter with no verses', 'Hosea 4'],
    ['a book with no space before the chapter', 'Hosea4:6'],
    ['a verse list nothing can read', 'Hosea 4:x'],
    ['a colon with no verses after it', 'Hosea 4:'],
    ['a descending range', 'Hosea 4:9-2'],
    ['a chapter outside any book', 'Hosea 0:6'],
  ])('refuses a message that is %s', (_case, text) => {
    expect(codeOf(() => parsePastorMessage(text))).toBe('ai_parse_failed');
  });
});

describe('upcomingSunday', () => {
  it.each([
    ['Sunday itself', '2026-09-13T09:30:00Z', '2026-09-13'],
    ['Monday', '2026-09-14T00:00:00Z', '2026-09-20'],
    ['Wednesday', '2026-09-16T12:00:00Z', '2026-09-20'],
    ['Saturday late at night', '2026-09-19T23:30:00Z', '2026-09-20'],
    ['a Tuesday that runs into the next month', '2026-09-29T08:00:00Z', '2026-10-04'],
  ])('answers with the coming Sunday from %s', (_case, now, expected) => {
    expect(upcomingSunday(new Date(now))).toBe(expected);
  });
});

describe('slugifyTitle', () => {
  it.each([
    ['GOD BREAK THE YOKE', 'god-break-the-yoke'],
    ['Gottes Güte — Teil 2!', 'gottes-gute-teil-2'],
    ['  ...Break   the/yoke...  ', 'break-the-yoke'],
    ['!!!', ''],
  ])('turns %j into %j', (title, slug) => {
    expect(slugifyTitle(title)).toBe(slug);
  });

  it('caps a long title instead of carrying the whole sentence into the filename', () => {
    const slug = slugifyTitle('The Lord is my shepherd and I shall not want for anything at all today');
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.startsWith('the-lord-is-my-shepherd')).toBe(true);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('resolveSermonFilename', () => {
  const friday = new Date('2026-09-18T10:00:00Z');

  it('dates the file by the coming Sunday and names it after the title', () => {
    expect(resolveSermonFilename('GOD BREAK THE YOKE', friday)).toBe('2026-09-20-god-break-the-yoke.yml');
  });

  it.each([
    ['there is no title', undefined],
    ['the title slugifies to nothing', '!!!'],
  ])('falls back to the bare date when %s', (_case, title) => {
    expect(resolveSermonFilename(title, friday)).toBe('2026-09-20.yml');
  });

  it('never lets a title reach out of the directory it is written in', () => {
    const filename = resolveSermonFilename('../../etc/passwd', friday);
    expect(filename).toBe('2026-09-20-etc-passwd.yml');
    expect(filename).not.toContain('/');
    expect(filename).not.toContain('..');
  });
});

describe('buildSermonYaml', () => {
  it('writes a file the sermon validator accepts, in message order and with duplicates kept', () => {
    const built = buildSermonYaml(parsePastorMessage(MESSAGE), TRANSLATIONS);
    expect(built.notices).toEqual([]);
    const sermon = parseSermonFile(built.yaml);
    expect(sermon.translations).toEqual(['SCH2000', 'TAOVBSI']);
    expect(sermon.notices).toEqual([]);
    expect(sermon.entries).toEqual([
      { book: 'LEV', chapter: 26, verses: [13], offsets: {} },
      { book: 'PSA', chapter: 118, verses: [24], offsets: {} },
      { book: '2SA', chapter: 1, verses: [6], offsets: {} },
      { book: '1CO', chapter: 13, verses: [4, 5, 6, 7], offsets: {} },
      { book: 'GEN', chapter: 30, verses: [34, 35], offsets: {} },
      { book: 'PSA', chapter: 118, verses: [24], offsets: {} },
      { book: 'HOS', chapter: 4, verses: [6], offsets: {} },
    ]);
  });

  it('keeps the verse list as the pastor grouped it rather than exploding it into a list', () => {
    const { yaml } = buildSermonYaml(parsePastorMessage(MESSAGE), TRANSLATIONS);
    expect(yaml).toContain('verses: 34,35');
    expect(yaml).toContain('verses: 4-7');
    expect(yaml).not.toMatch(/^\s+verses:\s*$/mu);
  });

  it('leaves a book it cannot place out of the file and reports the whole passage instead', () => {
    const built = buildSermonYaml(parsePastorMessage('Roman 7:15\nHosea 4:6'), ['KJV']);
    expect(built.notices).toHaveLength(1);
    expect(built.notices[0]).toContain('Roman 7:15');
    const sermon = parseSermonFile(built.yaml);
    expect(sermon.entries).toEqual([{ book: 'HOS', chapter: 4, verses: [6], offsets: {} }]);
    expect(sermon.notices).toEqual([]);
  });

  it('carries a verse list it could not read into the file it builds as a notice', () => {
    const built = buildSermonYaml(parsePastorMessage('Hosea 4:9-2\nHosea 4:6'), ['KJV']);
    expect(built.notices).toEqual([expect.stringContaining('Hosea 4:9-2')]);
    expect(parseSermonFile(built.yaml).entries).toEqual([
      { book: 'HOS', chapter: 4, verses: [6], offsets: {} },
    ]);
  });

  it.each([
    ['a three-letter token that names no book in the canon', 'Off 3:20'],
    ['a chapter past the end of the book it names', 'Hosea 99:1'],
  ])('leaves out %s and reports the line instead of writing it', (_case, passage) => {
    const built = buildSermonYaml(parsePastorMessage(`${passage}\nHosea 4:6`), ['KJV']);
    expect(built.notices).toHaveLength(1);
    expect(built.notices[0]).toContain(passage);
    const sermon = parseSermonFile(built.yaml);
    expect(sermon.entries).toEqual([{ book: 'HOS', chapter: 4, verses: [6], offsets: {} }]);
    expect(sermon.notices).toEqual([]);
  });

  it('refuses to write a file when no book in the message could be placed', () => {
    expect(codeOf(() => buildSermonYaml(parsePastorMessage('Roman 7:15'), ['KJV']))).toBe('ai_parse_failed');
  });

  it('names the passages it could not place in the refusal, rather than counting them', () => {
    const refuse = () => buildSermonYaml(parsePastorMessage('Roman 7:15\nOff 3:20'), ['KJV']);
    expect(refuse).toThrow(/Roman 7:15[\s\S]*Off 3:20/u);
    // The notices end in a period and so does the message they are folded into: one, not two.
    expect(refuse).toThrow(/[^.]\.$/u);
  });

  it('refuses translations the sermon validator would reject rather than emitting a broken file', () => {
    expect(codeOf(() => buildSermonYaml(parsePastorMessage('Hosea 4:6'), []))).toBe('sermon_invalid');
  });
});

describe('generateSermonFromText', () => {
  it('returns the preview alone: no request goes out and no file is written', async () => {
    // The guard proves itself first; an empty record from a mock that never took effect proves nothing.
    expect(() => writeFile('ignored', 'x')).toThrow(/must not write to the filesystem/);
    expect(fsWrites).toEqual(['writeFile']);
    fsWrites.length = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('the deterministic pipeline must not reach the network');
    });
    try {
      const result = await generateSermonFromText(MESSAGE, {
        translations: TRANSLATIONS,
        now: new Date('2026-09-18T10:00:00Z'),
      });
      expect(Object.keys(result).sort()).toEqual([
        'filename',
        'notices',
        'resolvedTokens',
        'resolver',
        'title',
        'yaml',
      ]);
      expect(result.filename).toBe('2026-09-20-god-break-the-yoke.yml');
      expect(result.title).toBe('GOD BREAK THE YOKE');
      expect(result.notices).toEqual([]);
      expect(parseSermonFile(result.yaml).entries).toHaveLength(7);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(fsWrites).toEqual([]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('names the file by date alone when the message carries no title', async () => {
    const result = await generateSermonFromText('Hosea 4:6', {
      translations: ['KJV'],
      now: new Date('2026-09-13T00:00:00Z'),
    });
    expect(result.filename).toBe('2026-09-13.yml');
    expect(result).not.toHaveProperty('title');
  });

  it('keeps a passage whose verse list it cannot read out of the title and the filename', async () => {
    const result = await generateSermonFromText('Hosea 4:9-2\nHosea 4:6', {
      translations: ['KJV'],
      now: new Date('2026-09-18T10:00:00Z'),
    });
    expect(result).not.toHaveProperty('title');
    expect(result.filename).toBe('2026-09-20.yml');
    expect(result.notices).toEqual([expect.stringContaining('Hosea 4:9-2')]);
    expect(parseSermonFile(result.yaml).entries).toHaveLength(1);
  });

  it('carries the notice for an unplaceable book out to the caller', async () => {
    const result = await generateSermonFromText("Today's Sermon. GOD BREAK THE YOKE\nRoman 7:15\nHosea 4:6", {
      translations: ['KJV'],
      now: new Date('2026-09-18T10:00:00Z'),
    });
    // Two: the book name was left over, and with no key configured nothing else was going to place it.
    expect(result.notices).toHaveLength(2);
    expect(result.notices[1]).toContain('Roman 7:15');
    expect(parseSermonFile(result.yaml).entries).toHaveLength(1);
  });

  it('reports resolver "not-needed" when every book name was already recognized', async () => {
    const result = await generateSermonFromText('John 3:16', {
      translations: ['ta'],
      now: new Date('2026-09-22T00:00:00Z'),
    });
    expect(result.resolver).toBe('not-needed');
    expect(result.resolvedTokens).toEqual([]);
  });

  it('reports resolver "not-configured" when a book name is unresolved and no key is set', async () => {
    const result = await generateSermonFromText('Xyzzy 1:1\nHosea 4:6', {
      translations: ['ta'],
      now: new Date('2026-09-22T00:00:00Z'),
    });
    expect(result.resolver).toBe('not-configured');
  });

  it('does not report an Object.prototype member as a resolved book', async () => {
    // Regression: an empty `codes` map is still a plain object, so a book token that happens to name an
    // inherited property (`constructor`, `toString`, ...) must not read back as "resolved" through it.
    const result = await generateSermonFromText('constructor 1:1\nHosea 4:6', {
      translations: ['ta'],
      now: new Date('2026-09-22T00:00:00Z'),
    });
    expect(result.resolver).toBe('not-configured');
    expect(result.resolvedTokens).toEqual([]);
  });

  it('reports resolver "used" with resolvedTokens when the resolver placed a book', async () => {
    const httpPost: HttpPost = async () => ({
      status: 200,
      body: JSON.stringify({
        content: [
          { type: 'tool_use', id: 'toolu_test', name: RESOLVE_TOOL_NAME, input: { resolutions: [{ token: 'Xyzzy', usfm: 'JHN' }] } },
        ],
      }),
    });
    const result = await generateSermonFromText('Xyzzy 1:1\nHosea 4:6', {
      translations: ['ta'],
      now: new Date('2026-09-22T00:00:00Z'),
      apiKey: 'test-key',
      httpPost,
    });
    expect(result.resolver).toBe('used');
    expect(result.resolvedTokens).toEqual([{ token: 'Xyzzy', book: 'JHN', source: 'ai' }]);
  });

  it('reports resolver "unavailable" when the resolver call throws', async () => {
    const httpPost: HttpPost = async () => ({ status: 500, body: '{}' });
    const result = await generateSermonFromText('Xyzzy 1:1\nHosea 4:6', {
      translations: ['ta'],
      now: new Date('2026-09-22T00:00:00Z'),
      apiKey: 'test-key',
      httpPost,
    });
    expect(result.resolver).toBe('unavailable');
    expect(result.resolvedTokens).toEqual([]);
  });
});

describe('generateSermonFromText with the optional book-name resolver', () => {
  /** Obviously not a key. Nothing in this repo may carry a string that could pass for a real one. */
  const API_KEY = 'test-api-key';
  const NOW = new Date('2026-09-18T10:00:00Z');

  function transport(reply: { status: number; body: string } | Error): {
    sent: string[];
    httpPost: HttpPost;
  } {
    const sent: string[] = [];
    const httpPost: HttpPost = async (_url, body) => {
      sent.push(body);
      if (reply instanceof Error) throw reply;
      return reply;
    };
    return { sent, httpPost };
  }

  function resolving(resolutions: Array<{ token: string; usfm: string }>): { status: number; body: string } {
    return {
      status: 200,
      body: JSON.stringify({
        content: [{ type: 'tool_use', id: 'toolu_test', name: RESOLVE_TOOL_NAME, input: { resolutions } }],
        usage: { input_tokens: 412, output_tokens: 27 },
      }),
    };
  }

  /** Every token the request actually asked about, read back out of the recorded body. */
  function tokensAsked(body: string): string {
    return (JSON.parse(body) as { messages: Array<{ content: string }> }).messages[0]!.content;
  }

  it('makes no request at all when every book name resolved without one', async () => {
    const { sent, httpPost } = transport(resolving([]));
    const calls: IntegrationCallInfo[] = [];
    const result = await generateSermonFromText(MESSAGE, {
      translations: TRANSLATIONS,
      now: NOW,
      apiKey: API_KEY,
      httpPost,
      onIntegrationCall: (call) => {
        calls.push(call);
      },
    });

    expect(sent).toHaveLength(0);
    expect(calls).toEqual([]);
    expect(result.notices).toEqual([]);
    expect(parseSermonFile(result.yaml).entries).toHaveLength(7);
  });

  it('asks only about the book names it could not place, once each, and writes what comes back', async () => {
    const { sent, httpPost } = transport(resolving([{ token: 'Roman', usfm: 'ROM' }]));
    const result = await generateSermonFromText('Roman 7:15\nRoman 8:1\nHosea 4:6', {
      translations: ['KJV'],
      now: NOW,
      apiKey: API_KEY,
      httpPost,
    });

    expect(sent).toHaveLength(1);
    const asked = tokensAsked(sent[0]!);
    expect(asked).toContain('Roman');
    expect(asked).not.toContain('Hosea');
    expect(asked.match(/Roman/gu)).toHaveLength(1);
    expect(result.notices).toEqual([]);
    expect(parseSermonFile(result.yaml).entries).toEqual([
      { book: 'ROM', chapter: 7, verses: [15], offsets: {} },
      { book: 'ROM', chapter: 8, verses: [1], offsets: {} },
      { book: 'HOS', chapter: 4, verses: [6], offsets: {} },
    ]);
  });

  it('re-checks what comes back against the canon, so a resolved book with a bad chapter is still reported', async () => {
    const { httpPost } = transport(resolving([{ token: 'Roman', usfm: 'ROM' }]));
    const result = await generateSermonFromText('Roman 99:1\nHosea 4:6', {
      translations: ['KJV'],
      now: NOW,
      apiKey: API_KEY,
      httpPost,
    });

    expect(result.notices).toEqual([expect.stringContaining('Roman 99:1')]);
    expect(result.notices[0]).toContain('Romans');
    expect(parseSermonFile(result.yaml).entries).toEqual([{ book: 'HOS', chapter: 4, verses: [6], offsets: {} }]);
  });

  it('falls back to the per-line notice for a token the answer left out', async () => {
    const { httpPost } = transport(resolving([]));
    const result = await generateSermonFromText('Roman 7:15\nHosea 4:6', {
      translations: ['KJV'],
      now: NOW,
      apiKey: API_KEY,
      httpPost,
    });

    expect(result.notices).toEqual([expect.stringContaining('Roman 7:15')]);
    expect(parseSermonFile(result.yaml).entries).toHaveLength(1);
  });

  it('completes deterministically with no key configured, saying once why nothing was resolved', async () => {
    const { sent, httpPost } = transport(resolving([{ token: 'Roman', usfm: 'ROM' }]));
    const calls: IntegrationCallInfo[] = [];
    const result = await generateSermonFromText('Roman 7:15\nHosea 4:6', {
      translations: ['KJV'],
      now: NOW,
      httpPost,
      onIntegrationCall: (call) => {
        calls.push(call);
      },
    });

    expect(sent).toEqual([]);
    expect(calls).toEqual([]);
    expect(result.notices).toHaveLength(2);
    expect(result.notices[0]).toContain('ANTHROPIC_API_KEY');
    expect(result.notices[1]).toContain('Roman 7:15');
    expect(parseSermonFile(result.yaml).entries).toHaveLength(1);
  });

  it('stays quiet about the key when every book name resolved without one', async () => {
    const result = await generateSermonFromText('Hosea 4:6', { translations: ['KJV'], now: NOW });
    expect(result.notices).toEqual([]);
  });

  it.each([
    ['the request never got through', new Error('getaddrinfo ENOTFOUND'), 'ai_request_failed'],
    ['the service refused', { status: 429, body: '{}' }, 'ai_request_failed'],
    ['the answer was unusable', { status: 200, body: 'not json' }, 'ai_response_invalid'],
  ])('keeps the deterministic file when %s, and says so once', async (_case, reply, code) => {
    const { sent, httpPost } = transport(reply);
    const calls: IntegrationCallInfo[] = [];
    const result = await generateSermonFromText('Roman 7:15\nHosea 4:6', {
      translations: ['KJV'],
      now: NOW,
      apiKey: API_KEY,
      httpPost,
      onIntegrationCall: (call) => {
        calls.push(call);
      },
    });

    expect(sent).toHaveLength(1);
    expect(result.notices).toHaveLength(2);
    expect(result.notices[1]).toContain('Roman 7:15');
    expect(parseSermonFile(result.yaml).entries).toEqual([{ book: 'HOS', chapter: 4, verses: [6], offsets: {} }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.outcome).toBe('refused');
    expect(calls[0]!.detail).toBe(code);
  });

  it('hands the audit hook one ADMN-04-shaped entry per call, carrying nothing it may not carry', async () => {
    const { httpPost } = transport(resolving([{ token: 'Roman', usfm: 'ROM' }]));
    const calls: IntegrationCallInfo[] = [];
    await generateSermonFromText('Roman 7:15\nHosea 4:6', {
      translations: ['KJV'],
      now: NOW,
      apiKey: API_KEY,
      httpPost,
      onIntegrationCall: (call) => {
        calls.push(call);
      },
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.action).toBe('integration.call');
    expect(call.subject).toBe('Anthropic book-name resolver');
    expect(call.outcome).toBe('allowed');
    expect(call.requestTokens).toBe(412);
    expect(call.responseTokens).toBe(27);
    expect(typeof call.durationMs).toBe('number');
    expect(call.durationMs).toBeGreaterThanOrEqual(0);
    expect(Object.keys(call).sort()).toEqual([
      'action',
      'detail',
      'durationMs',
      'outcome',
      'requestTokens',
      'responseTokens',
      'subject',
    ]);

    const serialized = JSON.stringify(call);
    for (const secret of [API_KEY, 'Roman', 'ROM', 'Romans', 'USFM', 'actor', 'correlationId']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('carries the token counts into a refused audit entry when the unusable answer still reported them', async () => {
    const { httpPost } = transport({
      status: 200,
      body: JSON.stringify({
        content: [
          { type: 'tool_use', name: RESOLVE_TOOL_NAME, input: { resolutions: [{ token: 'Roman', usfm: 'XYZ' }] } },
        ],
        usage: { input_tokens: 412, output_tokens: 27 },
      }),
    });
    const calls: IntegrationCallInfo[] = [];
    await generateSermonFromText('Roman 7:15\nHosea 4:6', {
      translations: ['KJV'],
      now: NOW,
      apiKey: API_KEY,
      httpPost,
      onIntegrationCall: (call) => {
        calls.push(call);
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.outcome).toBe('refused');
    expect(calls[0]!.requestTokens).toBe(412);
    expect(calls[0]!.responseTokens).toBe(27);
  });

  it('records the call without token counts when the answer reported none', async () => {
    const { httpPost } = transport({
      status: 200,
      body: JSON.stringify({
        content: [
          { type: 'tool_use', name: RESOLVE_TOOL_NAME, input: { resolutions: [{ token: 'Roman', usfm: 'ROM' }] } },
        ],
      }),
    });
    const calls: IntegrationCallInfo[] = [];
    await generateSermonFromText('Roman 7:15\nHosea 4:6', {
      translations: ['KJV'],
      now: NOW,
      apiKey: API_KEY,
      httpPost,
      onIntegrationCall: (call) => {
        calls.push(call);
      },
    });

    expect(Object.keys(calls[0]!).sort()).toEqual(['action', 'detail', 'durationMs', 'outcome', 'subject']);
  });

  it('waits for an audit hook that answers with a promise before returning', async () => {
    const { httpPost } = transport(resolving([{ token: 'Roman', usfm: 'ROM' }]));
    const seen: string[] = [];
    await generateSermonFromText('Roman 7:15\nHosea 4:6', {
      translations: ['KJV'],
      now: NOW,
      apiKey: API_KEY,
      httpPost,
      onIntegrationCall: async () => {
        await Promise.resolve();
        seen.push('recorded');
      },
    });

    expect(seen).toEqual(['recorded']);
  });

  it('keeps the resolved result when the audit hook throws synchronously on a successful call', async () => {
    const { httpPost } = transport(resolving([{ token: 'Roman', usfm: 'ROM' }]));
    let calls = 0;
    const result = await generateSermonFromText('Roman 7:15\nHosea 4:6', {
      translations: ['KJV'],
      now: NOW,
      apiKey: API_KEY,
      httpPost,
      onIntegrationCall: () => {
        calls += 1;
        throw new Error('audit sink down');
      },
    });

    expect(calls).toBe(1);
    expect(result.notices).toEqual([]);
    expect(parseSermonFile(result.yaml).entries).toEqual([
      { book: 'ROM', chapter: 7, verses: [15], offsets: {} },
      { book: 'HOS', chapter: 4, verses: [6], offsets: {} },
    ]);
  });

  it('keeps the deterministic result when the audit hook throws synchronously on a refused call', async () => {
    const { httpPost } = transport(new Error('getaddrinfo ENOTFOUND'));
    let calls = 0;
    const result = await generateSermonFromText('Roman 7:15\nHosea 4:6', {
      translations: ['KJV'],
      now: NOW,
      apiKey: API_KEY,
      httpPost,
      onIntegrationCall: () => {
        calls += 1;
        throw new Error('audit sink down');
      },
    });

    expect(calls).toBe(1);
    expect(result.notices).toHaveLength(2);
    expect(parseSermonFile(result.yaml).entries).toEqual([{ book: 'HOS', chapter: 4, verses: [6], offsets: {} }]);
  });

  it('keeps the resolved result when the audit hook rejects asynchronously on a successful call', async () => {
    const { httpPost } = transport(resolving([{ token: 'Roman', usfm: 'ROM' }]));
    let calls = 0;
    const result = await generateSermonFromText('Roman 7:15\nHosea 4:6', {
      translations: ['KJV'],
      now: NOW,
      apiKey: API_KEY,
      httpPost,
      onIntegrationCall: async () => {
        calls += 1;
        await Promise.resolve();
        throw new Error('audit sink down');
      },
    });

    expect(calls).toBe(1);
    expect(result.notices).toEqual([]);
    expect(parseSermonFile(result.yaml).entries).toEqual([
      { book: 'ROM', chapter: 7, verses: [15], offsets: {} },
      { book: 'HOS', chapter: 4, verses: [6], offsets: {} },
    ]);
  });

  it('keeps the deterministic result when the audit hook rejects asynchronously on a refused call', async () => {
    const { httpPost } = transport(new Error('getaddrinfo ENOTFOUND'));
    let calls = 0;
    const result = await generateSermonFromText('Roman 7:15\nHosea 4:6', {
      translations: ['KJV'],
      now: NOW,
      apiKey: API_KEY,
      httpPost,
      onIntegrationCall: async () => {
        calls += 1;
        await Promise.resolve();
        throw new Error('audit sink down');
      },
    });

    expect(calls).toBe(1);
    expect(result.notices).toHaveLength(2);
    expect(parseSermonFile(result.yaml).entries).toEqual([{ book: 'HOS', chapter: 4, verses: [6], offsets: {} }]);
  });
});
