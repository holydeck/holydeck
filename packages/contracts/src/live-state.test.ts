import { describe, expect, it } from 'vitest';
import { projectFor } from './live-state.js';
import type { LiveState } from './live-state.js';

const BASE: LiveState = {
  runId: 'run-1', snapshotId: 'snap-1', mode: 'live',
  public: { itemId: 'item-1', slideIndex: 0 }, selected: { itemId: 'item-2', slideIndex: 1 },
  themes: { operator: 'default', audience: 'default', stage: 'default', singer: 'default' },
  additionsRevision: 0,
};

describe('projectFor', () => {
  it('gives audience the public frame and nothing else', () => {
    const view = projectFor('audience', BASE);
    expect(view).toEqual({ view: 'audience', runId: 'run-1', snapshotId: 'snap-1', frame: BASE.public, themeId: 'default', additionsRevision: 0 });
    expect(view).not.toHaveProperty('selected');
  });

  it('gives singer an optional next position but never selected', () => {
    const next = { itemId: 'item-3', slideIndex: 0 };
    const view = projectFor('singer', BASE, { next });
    expect(view).toMatchObject({ view: 'singer', next });
    expect(view).not.toHaveProperty('selected');
  });

  it('gives stage the mode and the selected position as its preview', () => {
    const view = projectFor('stage', BASE);
    expect(view).toMatchObject({ view: 'stage', mode: 'live', selected: BASE.selected });
  });

  it('gives control the full authoritative state and connection counts', () => {
    const view = projectFor('control', BASE, { counts: { control: 1, audience: 4 } });
    expect(view).toEqual({ view: 'control', state: BASE, counts: { control: 1, audience: 4 } });
  });

  it('projects standby as a public frame, not a position', () => {
    const standby: LiveState = { ...BASE, public: { standby: 'screen-1' } };
    const view = projectFor('audience', standby);
    expect((view as { frame: unknown }).frame).toEqual({ standby: 'screen-1' });
  });

  it('never reads selectedPosition into an audience or singer projection, even if selected changes', () => {
    const moved: LiveState = { ...BASE, selected: { itemId: 'ANYTHING-PRIVATE', slideIndex: 99 } };
    for (const view of ['audience', 'singer'] as const) {
      expect(JSON.stringify(projectFor(view, moved))).not.toContain('ANYTHING-PRIVATE');
    }
  });
});
