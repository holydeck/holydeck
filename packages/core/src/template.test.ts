import { Liquid } from 'liquidjs';
import { describe, expect, it, vi } from 'vitest';
import { HolyDeckError } from './messages.js';
import {
  DEFAULT_TEMPLATE,
  LEGACY_DEFAULT_TEMPLATE,
  isLegacyTemplate,
  renderLegacyTemplate,
  renderOutput,
} from './template.js';
import type { EntryData, PassageData } from './template.js';

function passage(overrides: Partial<PassageData>): PassageData {
  return {
    translation: 'KJV',
    book: 'PSA',
    bookName: 'Psalm',
    chapter: 118,
    verses: '24',
    text: 'This is the day which the LORD hath made; we will rejoice and be glad in it.',
    citation: 'Psalm 118:24',
    revision: 1,
    fetchedAt: '2026-09-07T00:00:00.000Z',
    ...overrides,
  };
}

const entries: EntryData[] = [
  { reference: 'PSA 118:24', passages: [passage({}), passage({ translation: 'SCH2000', bookName: 'Psalmen', text: 'Ein Beispielvers auf Deutsch.', citation: 'Psalmen 118:24' })] },
];

describe('isLegacyTemplate', () => {
  it('detects {N.field} syntax', () => {
    expect(isLegacyTemplate(LEGACY_DEFAULT_TEMPLATE)).toBe(true);
    expect(isLegacyTemplate('{{ entries }}')).toBe(false);
    expect(isLegacyTemplate(DEFAULT_TEMPLATE)).toBe(false);
  });
});

describe('renderLegacyTemplate', () => {
  it('renders the old default template exactly like the old CLI', () => {
    expect(renderLegacyTemplate(LEGACY_DEFAULT_TEMPLATE, entries)).toBe(
      'This is the day which the LORD hath made; we will rejoice and be glad in it.\nPsalm 118:24\n\n',
    );
  });

  it('supports all five fields and multiple translation indexes', () => {
    expect(renderLegacyTemplate('{1.citation}|{0.book} {0.chapter}:{0.verses}|{1.passage}', entries)).toBe(
      'Psalmen 118:24|Psalm 118:24|Ein Beispielvers auf Deutsch.',
    );
  });

  it('throws template_index_out_of_range for a missing index', () => {
    try {
      renderLegacyTemplate('{2.passage}', entries);
      expect.unreachable();
    } catch (error) {
      expect((error as HolyDeckError).code).toBe('template_index_out_of_range');
    }
  });
});

describe('renderOutput', () => {
  it('renders the Liquid default template with citation and translation per passage', async () => {
    const output = await renderOutput(undefined, entries);
    expect(output).toContain('This is the day which the LORD hath made; we will rejoice and be glad in it.');
    expect(output).toContain('Psalm 118:24 (KJV)');
    expect(output).toContain('Psalmen 118:24 (SCH2000)');
  });

  it('routes legacy templates through the compat renderer and pushes a notice', async () => {
    const notices: string[] = [];
    const output = await renderOutput('{0.passage}', entries, notices);
    expect(output).toBe('This is the day which the LORD hath made; we will rejoice and be glad in it.');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('legacy');
  });

  it('renders custom Liquid templates', async () => {
    const output = await renderOutput('{% for e in entries %}{{ e.passages | size }}{% endfor %}', entries);
    expect(output).toBe('2');
  });

  it('wraps Liquid errors in template_invalid', async () => {
    await expect(renderOutput('{% broken', entries)).rejects.toMatchObject({ code: 'template_invalid' });
  });

  it('rethrows a HolyDeckError raised during Liquid rendering without rewrapping it', async () => {
    const inner = new HolyDeckError('template_index_out_of_range', { index: 0, count: 0 });
    const spy = vi.spyOn(Liquid.prototype, 'parseAndRender').mockRejectedValueOnce(inner);
    await expect(renderOutput(DEFAULT_TEMPLATE, entries)).rejects.toBe(inner);
    spy.mockRestore();
  });
});
