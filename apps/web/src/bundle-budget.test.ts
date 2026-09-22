import { describe, expect, it } from 'vitest';

import { ENTRY_BUDGET_BYTES, entryBudgetProblem, kilobytes, precacheChunks } from './bundle-budget.js';

describe('the entry budget', () => {
  it('lets an entry at or under 60 KB gzip through', () => {
    expect(entryBudgetProblem(0)).toBeUndefined();
    expect(entryBudgetProblem(ENTRY_BUDGET_BYTES)).toBeUndefined();
  });

  it('refuses an entry one byte over, and says by how much', () => {
    expect(entryBudgetProblem(ENTRY_BUDGET_BYTES + 1)).toBe('main.js is 60.0 KB gzip, over the 60.0 KB entry budget');
    expect(entryBudgetProblem(70 * 1024)).toContain('70.0 KB');
  });

  it('reads sizes to one decimal place', () => {
    expect(kilobytes(1536)).toBe('1.5 KB');
  });
});

describe('the chunks an offline device holds', () => {
  it('names every split chunk by the path a browser asks for it at, in a stable order', () => {
    const outputs = [
      'dist/main.js',
      'dist/main.js.map',
      'dist/chunks/output-B2.js',
      'dist/chunks/output-B2.js.map',
      'dist/chunks/chunk-A1.js',
      'dist/service-worker.js',
    ];
    expect(precacheChunks(outputs)).toEqual(['/chunks/chunk-A1.js', '/chunks/output-B2.js']);
  });

  it('holds nothing when the build split nothing out', () => {
    expect(precacheChunks(['dist/main.js'])).toEqual([]);
  });

  it('reads another build directory when told to', () => {
    expect(precacheChunks(['out/chunks/a.js'], 'out/')).toEqual(['/chunks/a.js']);
  });
});
