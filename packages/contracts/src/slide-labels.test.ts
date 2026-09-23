import { describe, expect, it } from 'vitest';

import { ENTITY_POLICIES } from './entities.js';
import { FIELD_CODES } from './problems.js';
import {
  CONFLICT_FIELDS,
  SHORTCUT_KEYS,
  SLIDE_LABEL_KIND,
  conflictsIn,
  conflictsWith,
  parseSlideLabelDraft,
  parseSlideLabelStatus,
  readAssignedLabel,
  readableConflict,
  shortcutsOf,
} from './slide-labels.js';

import type { ShortcutKey, SlideLabelEntry } from './slide-labels.js';

describe('reading slide-label status', () => {
  it('accepts archived', () => {
    expect(parseSlideLabelStatus({ archived: true })).toEqual({ ok: true, value: { archived: true } });
  });

  it('refuses missing archived', () => {
    expect(parseSlideLabelStatus({})).toEqual({ ok: false, problems: [{ path: 'slideLabel.archived', code: FIELD_CODES.required, message: 'is required' }] });
  });
});

const label = (id: string, name: string, shortcut?: ShortcutKey): SlideLabelEntry => ({
  id,
  name,
  ...(shortcut === undefined ? {} : { shortcut }),
});

const CATALOGUE: readonly SlideLabelEntry[] = [
  label('label-1', 'Verse', '1'),
  label('label-2', 'Chorus', '2'),
  label('label-3', 'Bridge'),
];

const codes = (value: unknown) => {
  const parsed = parseSlideLabelDraft(value, 'slideLabel');
  expect(parsed.ok).toBe(false);
  return parsed.ok ? [] : parsed.problems.map((problem) => `${problem.path}=${problem.code}`);
};

describe('what one slide label is', () => {
  it('is stamped as a kind this build decided the archiving of, so a catalogue entry can be stored', () => {
    const policy = ENTITY_POLICIES[SLIDE_LABEL_KIND];
    expect(policy.archive).toBe('hidden');
    expect(policy.deletion).toBe('never');
    expect(policy.portable).toBe(false);
    expect(policy.requirement).toBe('LABL-01');
  });

  it('carries a name and, when it is reachable live, one key of the closed shortcut space', () => {
    const parsed = parseSlideLabelDraft({ name: 'Verse', shortcut: '1' }, 'slideLabel');
    expect(parsed.ok && parsed.value).toEqual({ name: 'Verse', shortcut: '1' });
  });

  it('carries no shortcut at all when none was offered, because ten keys bound jumping, not labelling', () => {
    const parsed = parseSlideLabelDraft({ name: 'Bridge' }, 'slideLabel');
    expect(parsed.ok && parsed.value).toEqual({ name: 'Bridge' });
    expect(parsed.ok && 'shortcut' in parsed.value).toBe(false);
  });

  it('refuses a label nobody named, and one that is not a label at all', () => {
    expect(codes({ name: '' })).toEqual([`slideLabel.name=${FIELD_CODES.empty}`]);
    expect(codes({})).toEqual([`slideLabel.name=${FIELD_CODES.required}`]);
    expect(codes('Verse')).toEqual([`slideLabel=${FIELD_CODES.notAnObject}`]);
  });

  it('refuses a shortcut outside the closed key space, rather than binding a key nobody can press', () => {
    expect(codes({ name: 'Verse', shortcut: 'v' })).toEqual([`slideLabel.shortcut=${FIELD_CODES.notAllowed}`]);
    expect(codes({ name: 'Verse', shortcut: 'F5' })).toEqual([`slideLabel.shortcut=${FIELD_CODES.notAllowed}`]);
    expect(codes({ name: 'Verse', shortcut: 1 })).toEqual([`slideLabel.shortcut=${FIELD_CODES.notAllowed}`]);
  });

  it('accepts every key the space holds, so the list is the whole of what an Admin may assign', () => {
    for (const key of SHORTCUT_KEYS) {
      const parsed = parseSlideLabelDraft({ name: `Label ${key}`, shortcut: key }, 'slideLabel');
      expect(parsed.ok, key).toBe(true);
    }
  });

  it('names a shortcut space that is closed, unrepeated, and single-key throughout', () => {
    expect(new Set(SHORTCUT_KEYS).size).toBe(SHORTCUT_KEYS.length);
    for (const key of SHORTCUT_KEYS) expect(key, key).toHaveLength(1);
  });
});

describe('the catalogue is conflict-free across the whole shortcut space', () => {
  // Exhaustive rather than sampled: every key the space holds is claimed twice in turn, so a rule that
  // happened to hold for the digits somebody thought to type cannot pass while the space has a hole.
  it('refuses a second claim on every single key there is, naming the label already holding it', () => {
    for (const key of SHORTCUT_KEYS) {
      const held = label('held', 'Verse', key);
      const conflicts = conflictsWith([held], label('claiming', 'Chorus', key));
      expect(conflicts, key).toEqual([{ field: 'shortcut', claimed: key, heldBy: 'held' }]);
    }
  });

  it('lets a whole catalogue bind every key at once, because ten labels are ten distinct claims', () => {
    const full = SHORTCUT_KEYS.map((key, at) => label(`label-${at}`, `Label ${key}`, key));
    expect(conflictsIn(full)).toEqual([]);
    expect([...shortcutsOf(full).keys()]).toEqual([...SHORTCUT_KEYS]);
  });

  it('finds the one collision wherever in a full catalogue it is, rather than only near the start', () => {
    const full = SHORTCUT_KEYS.map((key, at) => label(`label-${at}`, `Label ${key}`, key));
    for (const [at, key] of SHORTCUT_KEYS.entries()) {
      const conflicts = conflictsIn([...full, label('late', 'Late', key)]);
      expect(conflicts, key).toEqual([{ field: 'shortcut', claimed: key, heldBy: `label-${at}` }]);
    }
  });

  it('holds the same rule for a name, because two labels called one thing cannot both be chosen', () => {
    expect(conflictsWith(CATALOGUE, label('new', 'Chorus'))).toEqual([
      { field: 'name', claimed: 'Chorus', heldBy: 'label-2' },
    ]);
    expect(CONFLICT_FIELDS).toEqual(['name', 'shortcut']);
  });

  it('reports both rules at once, so an Admin is told everything blocking the save', () => {
    const conflicts = conflictsWith(CATALOGUE, label('new', 'Verse', '2'));
    expect(conflicts).toEqual([
      { field: 'name', claimed: 'Verse', heldBy: 'label-1' },
      { field: 'shortcut', claimed: '2', heldBy: 'label-2' },
    ]);
    expect(conflicts.map(readableConflict)).toEqual([
      'the name Verse is already held by label-1',
      'the shortcut 2 is already held by label-2',
    ]);
  });

  it('lets a label keep its own name and its own key, which is what renaming one costs nothing', () => {
    expect(conflictsWith(CATALOGUE, label('label-1', 'Verse', '1'))).toEqual([]);
    expect(conflictsWith(CATALOGUE, label('label-1', 'Verse 1', '1'))).toEqual([]);
  });

  it('counts a label with no shortcut as claiming no key at all', () => {
    const unbound = [label('a', 'Reading'), label('b', 'Sermon')];
    expect(conflictsIn(unbound)).toEqual([]);
    expect(shortcutsOf(unbound).size).toBe(0);
  });

  it('is empty for a catalogue nothing was ever added to', () => {
    expect(conflictsIn([])).toEqual([]);
    expect(conflictsWith([], label('first', 'Verse', '1'))).toEqual([]);
  });
});

describe('a label an Editor assigns is one the catalogue already held', () => {
  it('reads back the whole entry, so what jumps to it is known at the moment it is chosen', () => {
    const parsed = readAssignedLabel(CATALOGUE, 'Chorus');
    expect(parsed.ok && parsed.value).toEqual({ id: 'label-2', name: 'Chorus', shortcut: '2' });
  });

  it('refuses an ad-hoc label, because a label is managed globally rather than typed per slide', () => {
    const parsed = readAssignedLabel(CATALOGUE, 'Verse 4');
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.problems).toEqual([
      {
        path: 'label',
        code: FIELD_CODES.notAllowed,
        message: 'must name a label of the global slide-label catalogue',
      },
    ]);
  });

  it('refuses an empty label and one that is not text, at the path it was read from', () => {
    expect(readAssignedLabel(CATALOGUE, '').ok).toBe(false);
    const parsed = readAssignedLabel(CATALOGUE, 7, 'slide.label');
    expect(parsed.ok ? [] : parsed.problems).toEqual([
      { path: 'slide.label', code: FIELD_CODES.notText, message: 'must be text' },
    ]);
  });

  it('refuses every label there is when the catalogue offers none', () => {
    expect(readAssignedLabel([], 'Chorus').ok).toBe(false);
  });
});
