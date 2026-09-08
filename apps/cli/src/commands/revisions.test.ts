import { describe, expect, it } from 'vitest';
import { makeContext, seedStore } from '../../test/harness.js';
import { runCli } from '../program.js';

async function seedTwoRevisions(dataDir: string): Promise<void> {
  await seedStore(dataDir, 'KJV', [
    { book: 'PSA', chapter: '117', verses: { '1': 'O praise the LORD, all ye nations' }, canonVerseCount: 2 },
  ]);
  await seedStore(dataDir, 'KJV', [
    { book: 'PSA', chapter: '117', verses: { '1': 'O praise the LORD, all ye peoples' }, canonVerseCount: 2 },
  ]);
}

describe('revisions', () => {
  it('lists revisions with number, date, and short hash', async () => {
    const setup = makeContext();
    await seedTwoRevisions(setup.dataDir);
    await expect(runCli(setup.ctx, ['revisions', 'KJV', 'PSA', '117'])).resolves.toBe(0);
    const out = setup.stdout();
    expect(out).toMatch(/rev 1 · fetched 2026-09-01 · [0-9a-f]{8}\n/);
    expect(out).toMatch(/rev 2 · fetched 2026-09-01 · [0-9a-f]{8}\n/);
  });

  it('accepts lowercase book codes', async () => {
    const setup = makeContext();
    await seedTwoRevisions(setup.dataDir);
    await expect(runCli(setup.ctx, ['revisions', 'KJV', 'psa', '117'])).resolves.toBe(0);
    expect(setup.stdout()).toContain('rev 1');
  });

  it('emits JSON with --json', async () => {
    const setup = makeContext();
    await seedTwoRevisions(setup.dataDir);
    await expect(runCli(setup.ctx, ['revisions', 'KJV', 'PSA', '117', '--json'])).resolves.toBe(0);
    const parsed = JSON.parse(setup.stdout()) as {
      translation: string;
      book: string;
      chapter: number;
      revisions: Array<{ rev: number; fetchedAt: string; contentHash: string }>;
    };
    expect(parsed.translation).toBe('KJV');
    expect(parsed.revisions.map((r) => r.rev)).toEqual([1, 2]);
  });

  it('diffs two revisions word by word', async () => {
    const setup = makeContext();
    await seedTwoRevisions(setup.dataDir);
    await expect(runCli(setup.ctx, ['revisions', 'KJV', 'PSA', '117', '--diff', '1..2'])).resolves.toBe(0);
    expect(setup.stdout()).toContain('[-nations-] {+peoples+}');
    expect(setup.stdout()).toContain('O praise the LORD');
  });

  it('rejects malformed --diff ranges', async () => {
    const setup = makeContext();
    await seedTwoRevisions(setup.dataDir);
    await expect(runCli(setup.ctx, ['revisions', 'KJV', 'PSA', '117', '--diff', 'abc'])).resolves.toBe(1);
    expect(setup.stderr()).toContain('Invalid --diff range "abc"');
  });

  it('errors on unknown revision numbers', async () => {
    const setup = makeContext();
    await seedTwoRevisions(setup.dataDir);
    await expect(runCli(setup.ctx, ['revisions', 'KJV', 'PSA', '117', '--diff', '1..9'])).resolves.toBe(1);
    expect(setup.stderr().toLowerCase()).toContain('revision');
  });

  it('orders multi-verse chapter text by verse number, not lexically, when diffing', async () => {
    // Verses '2' and '10' sort differently numerically (2, 10) vs lexically ('10' < '2'),
    // so this positionally distinguishes a correct numeric sort from a reversed or
    // lexical comparator: either bug would place verse 10's text before verse 2's.
    const setup = makeContext();
    await seedStore(setup.dataDir, 'KJV', [
      { book: 'PSA', chapter: '117', verses: { '10': 'ten pears', '2': 'two apples' }, canonVerseCount: 10 },
    ]);
    await seedStore(setup.dataDir, 'KJV', [
      { book: 'PSA', chapter: '117', verses: { '10': 'ten pears', '2': 'two oranges' }, canonVerseCount: 10 },
    ]);
    await expect(runCli(setup.ctx, ['revisions', 'KJV', 'PSA', '117', '--diff', '1..2'])).resolves.toBe(0);
    expect(setup.stdout()).toBe('2 two [-apples-] {+oranges+} 10 ten pears\n');
  });

  it('errors when the chapter is not stored', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['revisions', 'KJV', 'PSA', '117'])).resolves.toBe(1);
    expect(setup.stderr().toLowerCase()).toContain('not in the local datastore');
  });

  it('rejects a non-numeric chapter', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['revisions', 'KJV', 'PSA', 'seventeen'])).resolves.toBe(1);
    expect(setup.stderr()).toContain('Invalid reference');
  });

  it('is local-only', async () => {
    const setup = makeContext();
    await expect(
      runCli(setup.ctx, ['revisions', 'KJV', 'PSA', '117', '--server-url', 'https://holydeck.example.com']),
    ).resolves.toBe(1);
    expect(setup.stderr()).toContain('works on the local datastore');
  });
});
