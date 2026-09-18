import { describe, expect, it } from 'vitest';
import { detectRepeatMarker, splitScriptRuns } from './pptx-content.js';

describe('splitScriptRuns', () => {
  it('leaves a pure Latin-script block as one ta-Latn run', () => {
    expect(splitScriptRuns('Amazing Grace')).toEqual([{ languageKey: 'ta-Latn', text: 'Amazing Grace' }]);
  });

  it('leaves a pure Tamil-script block as one ta run', () => {
    expect(splitScriptRuns('அற்புத கிருபை')).toEqual([{ languageKey: 'ta', text: 'அற்புத கிருபை' }]);
  });

  it('splits a mixed-script block at the asserted boundary', () => {
    expect(splitScriptRuns('அற்புத Grace')).toEqual([
      { languageKey: 'ta', text: 'அற்புத ' },
      { languageKey: 'ta-Latn', text: 'Grace' },
    ]);
  });

  it('splits three runs where the script changes twice', () => {
    expect(splitScriptRuns('Amazing அற்புத Grace')).toEqual([
      { languageKey: 'ta-Latn', text: 'Amazing ' },
      { languageKey: 'ta', text: 'அற்புத ' },
      { languageKey: 'ta-Latn', text: 'Grace' },
    ]);
  });

  it('attaches leading neutral characters to the first run that follows them', () => {
    expect(splitScriptRuns('  "Grace"')).toEqual([{ languageKey: 'ta-Latn', text: '  "Grace"' }]);
  });

  it('attaches trailing neutral characters to the run they follow', () => {
    expect(splitScriptRuns('Grace!  ')).toEqual([{ languageKey: 'ta-Latn', text: 'Grace!  ' }]);
  });

  it('attaches a neutral stretch between two different-script runs to the run before it', () => {
    // Disclosed judgment call: the ruling does not pin down which side inter-run neutrals attach to.
    expect(splitScriptRuns('Grace, அற்புதம்')).toEqual([
      { languageKey: 'ta-Latn', text: 'Grace, ' },
      { languageKey: 'ta', text: 'அற்புதம்' },
    ]);
  });

  it('does not start a new run for digits or punctuation inside one script', () => {
    expect(splitScriptRuns('Verse 1: Amazing Grace, how sweet!')).toEqual([
      { languageKey: 'ta-Latn', text: 'Verse 1: Amazing Grace, how sweet!' },
    ]);
  });

  it('leaves a block with neither Tamil nor Latin script unsplit, tagged ta-Latn by default', () => {
    // Disclosed default (ruling 3): Cyrillic here has no Tamil or Latin character to key off of.
    expect(splitScriptRuns('Слава Богу')).toEqual([{ languageKey: 'ta-Latn', text: 'Слава Богу' }]);
  });

  it('leaves a pure punctuation/digit block (no letters at all) unsplit, tagged ta-Latn by default', () => {
    expect(splitScriptRuns('— 2 : 3, 4 —')).toEqual([{ languageKey: 'ta-Latn', text: '— 2 : 3, 4 —' }]);
  });

  it('handles the empty block without throwing', () => {
    expect(splitScriptRuns('')).toEqual([{ languageKey: 'ta-Latn', text: '' }]);
  });
});

describe('detectRepeatMarker', () => {
  it.each([
    ['x2', 2],
    ['X2', 2],
    ['×3', 3],
    ['(x2)', 2],
    ['(×4)', 4],
    ['  x5  ', 5],
    ['repeat 2', 2],
    ['repeat 2x', 2],
    ['REPEAT 3 times', 3],
    ['repeat   7', 7],
  ])('converts %j to a structured count of %d', (text, count) => {
    expect(detectRepeatMarker(text)).toEqual({ count });
  });

  it('leaves a matched count below the smallest repeat as ordinary text', () => {
    expect(detectRepeatMarker('x1')).toBeUndefined();
    expect(detectRepeatMarker('repeat 1')).toBeUndefined();
    expect(detectRepeatMarker('repeat 0')).toBeUndefined();
  });

  it('leaves ordinary lyric text alone', () => {
    expect(detectRepeatMarker('Amazing Grace')).toBeUndefined();
  });

  it('leaves a block that is only partly a marker alone (the whole trimmed content must match)', () => {
    expect(detectRepeatMarker('Chorus x2')).toBeUndefined();
    expect(detectRepeatMarker('x2 please')).toBeUndefined();
  });

  it('leaves out-of-scope repeat phrasing alone, as a documented v1 limitation', () => {
    expect(detectRepeatMarker('repeated twice')).toBeUndefined();
    expect(detectRepeatMarker('x 2 times')).toBeUndefined();
  });

  it('never throws on an empty block', () => {
    expect(detectRepeatMarker('')).toBeUndefined();
  });
});
