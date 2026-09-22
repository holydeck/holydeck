import { CONTENT_LANGUAGES } from '@holydeck/contracts/content-languages';
import { SNAPSHOT_PINS, parsePreparedSnapshot } from '@holydeck/contracts/snapshots';
import { isRevisionAddress } from '@holydeck/contracts/revisions';
import { describe, expect, it } from 'vitest';

import { CATEGORY_OF } from './audit.js';
import { RECORDS, RECORD_ACTIONS } from './records.js';
import { repositoriesOn } from './repositories.js';
import { revisionsOn } from './revisions.js';
import { ACCOUNTS_MANAGE, PRESENTATION_CONTROL, SERVICE_TEMPLATES_MANAGE, permissionsFor } from './roles.js';
import { serviceContext, servicesOn } from './services.js';
import { slideGroupsOn } from './slide-groups.js';
import { slideLayoutContext, slideLayoutsOn } from './slide-layouts.js';
import { songContext, songsOn } from './songs.js';
import {
  CHECK_SEVERITIES,
  LIVE_LABEL,
  LIVE_OVERRIDDEN_LABEL,
  OVERRIDE_ACTION,
  PreparationError,
  READINESS_GROUPS,
  READINESS_STATES,
  READINESS_TARGETS,
  RUN_EVENT_RECORD,
  SNAPSHOT_RECORD,
  overrideProblem,
  preparationContext,
  preparationOn,
  transitionProblem,
} from './snapshots.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { AccountRecord } from '@holydeck/contracts/accounts';
import type { TextLayoutBox } from '@holydeck/contracts/layouts';
import type { ServiceDraft, ServiceSection } from '@holydeck/contracts/services';
import type { GeneratedSlideProvenance } from '@holydeck/contracts/snapshots';
import type { SongBody } from '@holydeck/contracts/songs';

import type { Document } from './repositories.js';
import type { SongGeneration } from './songs.js';
import type {
  OperatorSession,
  OverrideRequest,
  PreparationInputs,
  PreparationStore,
  ReadinessCheck,
  ReadinessChecklist,
  ReadinessObservation,
  ReadinessOverride,
} from './snapshots.js';
import type { ServiceStore } from './services.js';
import type { FakeDb } from '../test/helpers/fake-db.js';

const START = Date.parse('2026-09-13T09:30:00.000Z');
const OPERATOR = `account:${'D'.repeat(22)}`;
const CORRELATION = 'req-7b21c0ae';
const CONTEXT = preparationContext(OPERATOR, CORRELATION);
const EDITOR = serviceContext(OPERATOR, CORRELATION);
const SNAPSHOTS = RECORDS.preparedSnapshots.collection;
const RUN_EVENTS = RECORDS.runEvents.collection;
const AUDIT = RECORDS.auditEvents.collection;

const SECTIONS: readonly ServiceSection[] = [
  {
    id: 'section-1', name: 'Worship', items: [
      { id: 'item-1', kind: 'song', title: 'Amazing Grace', enabled: true, content: { id: 'song-4', revision: 5, hash: 'fnv1a-6fe1d1e9' } },
      { id: 'item-2', kind: 'custom-slide', title: 'Welcome', enabled: true, content: undefined },
    ],
  },
  {
    id: 'section-2', name: 'Word', items: [
      { id: 'item-3', kind: 'sermon', title: 'Grace', enabled: true, content: { id: 'sermon-2', revision: 9, hash: undefined } },
    ],
  },
];
const DRAFT: ServiceDraft = { title: 'Sunday Morning', date: '2026-09-13', site: 'Main Hall', sections: SECTIONS };

const INPUTS: PreparationInputs = {
  slideLayout: { id: 'layout-1', revision: 3 },
  serviceTemplate: 'template-1@2',
  settings: 'settings@41',
  media: 'media@2026-09-12',
  corpus: 'corpus@2026-08-01',
  aspectRatio: '16:9',
};

// The six groups ADR 0003 names, one check apiece, so a checklist built from them spans the whole shape.
const MEDIA_MISSING: ReadinessCheck = {
  name: 'Media: one file missing',
  group: 'Media',
  severity: 'blocker',
  cause: 'welcome.mp4 is not in the media store',
};
const NO_OUTPUT: ReadinessCheck = {
  name: 'Outputs: no output window',
  group: 'Outputs',
  severity: 'blocker',
  cause: 'no output window has opened for this service',
};
const ONE_TRANSLATION: ReadinessCheck = {
  name: 'Bible: one reading has a single translation',
  group: 'Bible',
  severity: 'warning',
  cause: 'John 1 is pinned in one translation only',
};
const REHEARSED: ReadinessCheck = {
  name: 'Rehearsal: the service has been rehearsed',
  group: 'Rehearsal',
  severity: 'complete',
  cause: 'a rehearsal ran on 2026-09-12',
};
const CACHED: ReadinessCheck = {
  name: 'Offline: every asset is cached',
  group: 'Offline',
  severity: 'complete',
  cause: 'the offline cache holds every asset this service replays',
};

const accountOf = (role: AccountRecord['role'], granted: Partial<AccountRecord> = {}): AccountRecord => ({
  id: 'A'.repeat(22),
  name: 'lucia',
  displayName: 'Lucia Brandt',
  role,
  createdAt: '2026-09-13T09:30:00.000Z',
  controlPresentation: false,
  disabled: false,
  ...granted,
});

const sessionOf = (account: AccountRecord): OperatorSession => ({
  actor: OPERATOR,
  permissions: permissionsFor(account),
  correlationId: CORRELATION,
});

// The Operator is whoever holds Control presentation, whatever role they hold: a member here, because
// the permission is granted per account and never implied by one of the three roles.
const OPERATOR_SESSION = sessionOf(accountOf('member', { controlPresentation: true }));

/** What the deployment sees for itself — the checks media, Bible and output readiness contribute. */
const OBSERVED: ReadinessObservation = { checks: [MEDIA_MISSING, NO_OUTPUT, ONE_TRANSLATION, REHEARSED] };

interface Harness {
  readonly db: FakeDb;
  readonly services: ServiceStore;
  readonly preparation: PreparationStore;
}

const harness = (now?: () => string, observed: ReadinessObservation = OBSERVED): Harness => {
  const db = fakeDb();
  let tick = 0;
  let serial = 0;
  const clock = now ?? ((): string => new Date(START + (tick += 1) * 1000 - 1000).toISOString());
  return {
    db,
    services: servicesOn(db, { now: clock, newId: () => `service-${(serial += 1)}` }),
    preparation: preparationOn(db, {
      now: clock,
      newId: () => `audit-${(serial += 1)}`,
      observe: () => observed,
    }),
  };
};

const prepared = async (observed?: ReadinessObservation): Promise<Harness & { readonly serviceId: string }> => {
  const built = harness(undefined, observed);
  const service = await built.services.create(EDITOR, DRAFT);
  await built.preparation.prepare(CONTEXT, service.stamp.id, INPUTS);
  return { ...built, serviceId: service.stamp.id };
};

const rows = (db: FakeDb, collection: string): Document[] => db.rows.get(collection) ?? [];

const refused = async (call: Promise<unknown>): Promise<PreparationError> => {
  try {
    await call;
  } catch (error) {
    if (error instanceof PreparationError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

const checklistOf = (
  blockers: readonly ReadinessCheck[],
  warnings: readonly ReadinessCheck[] = [],
  completed: readonly ReadinessCheck[] = [],
  state: ReadinessChecklist['state'] = 'blocked',
): ReadinessChecklist => ({ state, blockers, warnings, completed });

const overrideOf = (carried: readonly ReadinessCheck[], changed: Partial<ReadinessOverride> = {}): ReadinessOverride => ({
  operator: OPERATOR,
  reason: 'The backup projector is on standby and the missing file is cosmetic',
  auditEntry: OVERRIDE_ACTION,
  runLabel: LIVE_OVERRIDDEN_LABEL,
  carried,
  ...changed,
});

describe('the vocabulary readiness is said in', () => {
  it('declares the groups, the severities, the states and the targets, and only those', () => {
    expect(READINESS_GROUPS).toEqual(['Content', 'Media', 'Bible', 'Offline', 'Outputs', 'Rehearsal']);
    expect(CHECK_SEVERITIES).toEqual(['blocker', 'warning', 'complete']);
    expect(READINESS_STATES).toEqual(['not prepared', 'preparing', 'ready', 'outdated', 'blocked']);
    expect(READINESS_TARGETS).toEqual(['Ready', 'Rehearsal', 'Go Live']);
    // Not a percentage, not a count of green checks, not a grade. Three severities and nothing to average.
    expect(CHECK_SEVERITIES.some((severity) => Number.isFinite(Number(severity)))).toBe(false);
  });
});

// ADR 0006: the manifest pins everything a run replays from, plus the two values it resolves once.
describe('the prepared manifest', () => {
  it('pins every revision a run replays from, with the geometry it resolved', async () => {
    const { preparation, serviceId } = await prepared();

    const record = await preparation.prepared(CONTEXT, serviceId);

    expect(Object.keys(record?.snapshot.pins ?? {}).sort()).toEqual([...SNAPSHOT_PINS].sort());
    expect(Object.values(record?.snapshot.pins ?? {}).every((pin) => pin !== '')).toBe(true);
    expect(record?.snapshot.resolved).toEqual({
      aspectRatio: '16:9',
      safeAreaMargins: { top: 5, right: 5, bottom: 5, left: 5, unit: 'percent' },
    });
    expect(record?.snapshot.immutable).toBe(true);
    expect(parsePreparedSnapshot(record?.snapshot).ok).toBe(true);
  });

  // ADR 0004: what a preparer names as generated is recorded verbatim, and a manifest naming none
  // reads back as an empty list rather than requiring one.
  it('records the generated slide provenance a preparer names, and defaults to none', async () => {
    const built = harness();
    const service = await built.services.create(EDITOR, DRAFT);
    const generatedSlides: readonly GeneratedSlideProvenance[] = [{
      slideGroupId: 'group-1', slideGroupRevision: 2, sourceId: 'song-1', sourceRevision: 3,
      slideLayoutId: 'layout-1', slideLayoutRevision: 3,
    }];

    await built.preparation.prepare(CONTEXT, service.stamp.id, { ...INPUTS, generatedSlides });
    const withGenerated = await built.preparation.prepared(CONTEXT, service.stamp.id);
    expect(withGenerated?.snapshot.generatedSlides).toEqual(generatedSlides);

    const { preparation, serviceId } = await prepared();
    const withNone = await preparation.prepared(CONTEXT, serviceId);
    expect(withNone?.snapshot.generatedSlides).toEqual([]);
  });

  it('refuses a manifest whose pin is missing', async () => {
    const built = harness();
    const service = await built.services.create(EDITOR, DRAFT);

    for (const pin of ['serviceTemplate', 'settings', 'media', 'corpus'] as const) {
      const error = await refused(
        built.preparation.prepare(CONTEXT, service.stamp.id, { ...INPUTS, [pin]: '' }),
      );
      expect(error.kind).toBe('schema');
      expect(error.message).toContain(pin);
    }
    expect(rows(built.db, SNAPSHOTS)).toHaveLength(0);
  });

  it('pins the Service at the ordinal its standing stamp holds, so an edit needs a new manifest', async () => {
    const { db, services, preparation, serviceId } = await prepared();
    const before = await preparation.prepared(CONTEXT, serviceId);

    await services.disableItem(EDITOR, serviceId, 'item-1');
    await preparation.prepare(CONTEXT, serviceId, INPUTS);

    const after = await preparation.prepared(CONTEXT, serviceId);
    expect(after?.snapshot.pins.service).not.toBe(before?.snapshot.pins.service);
    expect(after?.snapshot.pins.content).not.toBe(before?.snapshot.pins.content);
    expect(rows(db, SNAPSHOTS)).toHaveLength(2);
  });

  it('pins the content of the items a run would show, addressed by what they are', async () => {
    const { preparation, serviceId } = await prepared();

    const record = await preparation.prepared(CONTEXT, serviceId);

    expect(isRevisionAddress(record?.snapshot.pins.content ?? '')).toBe(true);
    expect(record?.snapshot.pins.slideLayout).toBe('layout-1@3');
  });

  it('resolves a ratio to what it is rather than to the numbers it arrived as', async () => {
    const built = harness();
    const service = await built.services.create(EDITOR, DRAFT);

    const record = await built.preparation.prepare(CONTEXT, service.stamp.id, { ...INPUTS, aspectRatio: '1920:1080' });

    expect(record?.snapshot.resolved.aspectRatio).toBe('16:9');
  });

  it('refuses a ratio that is not one', async () => {
    const built = harness();
    const service = await built.services.create(EDITOR, DRAFT);

    const error = await refused(built.preparation.prepare(CONTEXT, service.stamp.id, { ...INPUTS, aspectRatio: 'wide' }));

    expect(error.kind).toBe('schema');
  });

  it('answers nothing for a Service that is not there', async () => {
    const built = harness();

    expect(await built.preparation.prepare(CONTEXT, 'service-missing', INPUTS)).toBeUndefined();
    expect(await built.preparation.prepared(CONTEXT, 'service-missing')).toBeUndefined();
    expect(await built.preparation.readiness(CONTEXT, 'service-missing')).toBeUndefined();
  });
});

// ADR 0006 again: a mutation attempt fails at the storage layer, because no storage layer offers one.
describe('a manifest once written', () => {
  it('has no path through the data layer that could change or remove it', async () => {
    const { db } = await prepared();

    expect(Object.keys(repositoriesOn(db)[SNAPSHOT_RECORD]).sort()).toEqual(['append', 'count', 'read', 'record']);
    expect(RECORDS.preparedSnapshots.kind).toBe('immutable');
    expect(RECORDS.runEvents.kind).toBe('immutable');
    for (const verb of ['delete', 'findAndModify', 'remove', 'replace', 'update']) {
      expect(RECORD_ACTIONS).not.toContain(verb);
    }
  });

  it('refuses a second manifest written over the one already there, and leaves it as it was', async () => {
    const frozen = harness(() => new Date(START).toISOString());
    const service = await frozen.services.create(EDITOR, DRAFT);
    const first = await frozen.preparation.prepare(CONTEXT, service.stamp.id, INPUTS);
    const written = structuredClone(rows(frozen.db, SNAPSHOTS));

    const error = await refused(frozen.preparation.prepare(CONTEXT, service.stamp.id, { ...INPUTS, corpus: 'corpus@2026-09-01' }));

    expect(error.kind).toBe('conflict');
    expect(rows(frozen.db, SNAPSHOTS)).toEqual(written);
    expect((await frozen.preparation.prepared(CONTEXT, service.stamp.id))?.snapshot).toEqual(first?.snapshot);
  });
});

// ADR 0003: readiness is a severity-aware checklist. A percentage would let a blocker be averaged away.
describe('readiness', () => {
  it('is a checklist of blockers, warnings and completed checks, and carries no score', async () => {
    const { preparation, serviceId } = await prepared();

    const checklist = await preparation.readiness(CONTEXT, serviceId, {
      checks: [MEDIA_MISSING, ONE_TRANSLATION, REHEARSED, CACHED],
    });

    expect(Object.keys(checklist ?? {}).sort()).toEqual(['blockers', 'completed', 'state', 'warnings']);
    expect(checklist?.blockers).toContainEqual(MEDIA_MISSING);
    expect(checklist?.warnings).toEqual([ONE_TRANSLATION]);
    expect(checklist?.completed).toEqual(expect.arrayContaining([REHEARSED, CACHED]));
    for (const check of [...(checklist?.blockers ?? []), ...(checklist?.warnings ?? []), ...(checklist?.completed ?? [])]) {
      expect(READINESS_GROUPS).toContain(check.group);
      expect(check.cause).not.toBe('');
      expect(Object.values(check).some((field) => typeof field === 'number')).toBe(false);
    }
  });

  it('reports not prepared before anything is pinned, and ready once nothing blocks', async () => {
    const built = harness();
    const service = await built.services.create(EDITOR, DRAFT);

    expect((await built.preparation.readiness(CONTEXT, service.stamp.id))?.state).toBe('not prepared');

    await built.preparation.prepare(CONTEXT, service.stamp.id, INPUTS);

    expect((await built.preparation.readiness(CONTEXT, service.stamp.id))?.state).toBe('ready');
  });

  it('reports blocked while a blocker is open', async () => {
    const { preparation, serviceId } = await prepared();

    const checklist = await preparation.readiness(CONTEXT, serviceId, { checks: [NO_OUTPUT, ONE_TRANSLATION] });

    expect(checklist?.state).toBe('blocked');
  });

  it('blocks a Service with nothing enabled to show', async () => {
    const { services, preparation, serviceId } = await prepared();
    for (const item of ['item-1', 'item-2', 'item-3']) await services.disableItem(EDITOR, serviceId, item);

    const checklist = await preparation.readiness(CONTEXT, serviceId);

    expect(checklist?.state).toBe('blocked');
    expect(checklist?.blockers.map((check) => check.group)).toEqual(['Content']);
    expect(checklist?.blockers[0]?.name).toBe('Content: nothing is enabled to show');
  });

  // ADR 0005 by way of T40: the one pin whose movement makes a prepared manifest stale.
  it('reports outdated once the Slide Layout it pinned has moved on, and outdated is not ready', async () => {
    const { preparation, serviceId } = await prepared();

    const checklist = await preparation.readiness(CONTEXT, serviceId, { slideLayoutRevision: 4 });

    expect(checklist?.state).toBe('outdated');
    expect(checklist?.blockers.map((check) => check.name)).toContain('Content: the Slide Layout moved on');
    expect(checklist?.blockers[0]?.cause).toContain('regeneration and revalidation');
    expect(transitionProblem('outdated', 'Ready', checklist as ReadinessChecklist)).toBe(
      'transition to Ready: Outdated is not Ready and must not report as Ready',
    );
  });

  it('stays ready while the Slide Layout it pinned is still the current one', async () => {
    const { preparation, serviceId } = await prepared();

    const checklist = await preparation.readiness(CONTEXT, serviceId, { slideLayoutRevision: 3 });

    expect(checklist?.state).toBe('ready');
    expect(checklist?.completed.map((check) => check.name)).toContain('Content: the Slide Layout pinned is still current');
  });
});

// ADR 0004 + T40: a generated slide group is projected from the same pinned Slide Layout revision the
// manifest's own pin names, so the Layout moving on is Outdated for both — and, T40's own rule, nothing
// regenerates on its own. Only an explicit `generate` call followed by a fresh `prepare` ever produces
// the new output; the Layout edit alone changes nothing already pinned.
// ADR 0004's decision: a generated slide is a deterministic projection of a pinned source revision and a
// pinned Slide Layout revision, and every generated slide records both.
describe('a generated slide group after preparation (ADR 0004)', () => {
  const TA = CONTENT_LANGUAGES[0]!.key;

  const composed = () => {
    const db = fakeDb();
    let tick = 0;
    let serial = 0;
    const now = () => new Date(START + (tick += 1) * 1000 - 1000).toISOString();
    const options = { now, newId: () => `id-${(serial += 1)}` };
    return {
      services: servicesOn(db, options),
      songs: songsOn(db, options),
      revisions: revisionsOn(db, options),
      groups: slideGroupsOn(db, options),
      layouts: slideLayoutsOn(db, { now, newId: () => `layout-${(serial += 1)}` }),
      preparation: preparationOn(db, { now, newId: () => `audit-${(serial += 1)}`, observe: () => OBSERVED }),
    };
  };

  const titleBox = (id: string): TextLayoutBox => ({
    id, kind: 'text', importance: 'required', frame: { x: 0, y: 0, width: 1, height: 1 },
    binding: { mode: 'keyed', contentKind: 'song', contentKey: 'title', languageKey: TA },
    style: { fontFamily: 'Inter', fontWeight: 400, sizeRatio: 0.05, lineHeight: 1, align: 'start', verticalAlign: 'start' },
  });

  it('goes Outdated when the pinned Layout moves on, and regenerates only after an explicit revalidation', async () => {
    const { services, songs, layouts, groups, revisions, preparation } = composed();
    const layoutAdmin = slideLayoutContext(OPERATOR, CORRELATION);
    const songAdmin = songContext(OPERATOR, CORRELATION);
    const song: SongBody = {
      titles: { tamil: 'பாடல்', romanized: 'Paadal' },
      languages: [TA],
      sections: [{ id: 'verse-1', label: 'Verse 1', text: [{ languageKey: TA, text: 'வரி' }] }],
      provenance: { source: 'manual' },
    };

    const layout = await layouts.create(layoutAdmin, { name: 'Song layout', body: { boxes: [titleBox('title')] } });
    const created = await songs.create(songAdmin, 'Paadal', song);
    const first: SongGeneration = { songRevision: created.revision, slideLayoutId: layout.stamp.id, slideLayoutRevision: layout.revision };
    const group = await songs.generate(songAdmin, created.stamp.id, first);
    const groupRevision = (await revisions.current(songAdmin, group.stamp.id))!.revision;

    const service = await services.create(EDITOR, DRAFT);
    const pinnedAtOne: readonly GeneratedSlideProvenance[] = [{
      slideGroupId: group.stamp.id, slideGroupRevision: groupRevision,
      sourceId: created.stamp.id, sourceRevision: created.revision,
      slideLayoutId: layout.stamp.id, slideLayoutRevision: layout.revision,
    }];
    await preparation.prepare(CONTEXT, service.stamp.id, {
      ...INPUTS, slideLayout: { id: layout.stamp.id, revision: layout.revision }, generatedSlides: pinnedAtOne,
    });

    expect((await preparation.readiness(CONTEXT, service.stamp.id, { slideLayoutRevision: layout.revision }))?.state).toBe('ready');

    // The Layout edit alone: nothing about the manifest or the generated group changes yet.
    const edited = await layouts.version(layoutAdmin, layout.stamp.id, { boxes: [titleBox('title'), titleBox('title-2')] });

    const outdated = await preparation.readiness(CONTEXT, service.stamp.id, { slideLayoutRevision: edited!.revision });
    expect(outdated?.state).toBe('outdated');
    expect(outdated?.blockers.map((check) => check.name)).toContain('Content: the Slide Layout moved on');
    expect(outdated?.blockers[0]?.cause).toContain('regeneration and revalidation');
    expect((await groups.current(songAdmin, group.stamp.id))?.body.generatedFrom).toEqual(group.body.generatedFrom);
    expect((await preparation.prepared(CONTEXT, service.stamp.id))?.snapshot.generatedSlides).toEqual(pinnedAtOne);

    // Explicit revalidation: regenerate against the new Layout revision, then prepare a fresh manifest.
    const revalidated = await songs.generate(songAdmin, created.stamp.id, { ...first, slideLayoutRevision: edited!.revision, slideGroupId: group.stamp.id });
    expect(revalidated.body.generatedFrom).toEqual({
      songId: created.stamp.id, songRevision: created.revision, slideLayoutId: layout.stamp.id, slideLayoutRevision: edited!.revision,
    });
    const revalidatedRevision = (await revisions.current(songAdmin, group.stamp.id))!.revision;
    expect(revalidatedRevision).not.toBe(groupRevision);

    const pinnedAtTwo: readonly GeneratedSlideProvenance[] = [{
      slideGroupId: group.stamp.id, slideGroupRevision: revalidatedRevision,
      sourceId: created.stamp.id, sourceRevision: created.revision,
      slideLayoutId: layout.stamp.id, slideLayoutRevision: edited!.revision,
    }];
    await preparation.prepare(CONTEXT, service.stamp.id, {
      ...INPUTS, slideLayout: { id: layout.stamp.id, revision: edited!.revision }, generatedSlides: pinnedAtTwo,
    });

    const revalidatedReadiness = await preparation.readiness(CONTEXT, service.stamp.id, { slideLayoutRevision: edited!.revision });
    expect(revalidatedReadiness?.state).toBe('ready');
    expect((await preparation.prepared(CONTEXT, service.stamp.id))?.snapshot.generatedSlides).toEqual(pinnedAtTwo);
  });
});

describe('the transition a blocker stops', () => {
  it('cannot skip from Preparing to Ready with an open blocker', () => {
    expect(transitionProblem('preparing', 'Ready', checklistOf([MEDIA_MISSING, NO_OUTPUT]))).toBe(
      'transition to Ready: bypassed 2 blocker(s)',
    );
  });

  it('cannot reach Rehearsal over a blocker either', () => {
    expect(transitionProblem('preparing', 'Rehearsal', checklistOf([MEDIA_MISSING]))).toBe(
      'transition to Rehearsal: bypassed 1 blocker(s)',
    );
  });

  it('allows Preparing to Ready once nothing is open', () => {
    expect(transitionProblem('preparing', 'Ready', checklistOf([], [ONE_TRANSLATION], [REHEARSED], 'ready'))).toBeUndefined();
  });

  it('refuses Go Live over a blocker that nobody overrode', () => {
    expect(transitionProblem('blocked', 'Go Live', checklistOf([MEDIA_MISSING]))).toBe(
      'transition to Go Live: bypassed 1 blocker(s) with no override',
    );
  });

  it('allows Go Live over a blocker a complete override carries', () => {
    const checklist = checklistOf([MEDIA_MISSING, NO_OUTPUT]);

    expect(transitionProblem('blocked', 'Go Live', checklist, overrideOf(checklist.blockers))).toBeUndefined();
  });
});

describe('what makes an override incomplete', () => {
  const checklist = checklistOf([MEDIA_MISSING, NO_OUTPUT], [ONE_TRANSLATION]);
  const cases: readonly (readonly [string, ReadinessOverride, string])[] = [
    ['nobody named', overrideOf(checklist.blockers, { operator: '   ' }), 'overridden by nobody, not an Operator'],
    ['no reason', overrideOf(checklist.blockers, { reason: '' }), 'overridden without a reason'],
    ['a whitespace reason', overrideOf(checklist.blockers, { reason: '  \t ' }), 'overridden without a reason'],
    ['no audit entry', overrideOf(checklist.blockers, { auditEntry: '' }), 'overridden without an audit entry'],
    ['a run labelled nothing', overrideOf(checklist.blockers, { runLabel: '' }), 'the run is labelled nothing, not live overridden'],
    ['a run labelled live', overrideOf(checklist.blockers, { runLabel: LIVE_LABEL }), 'the run is labelled live, not live overridden'],
    ['too few checks carried', overrideOf([MEDIA_MISSING]), '1 check(s) carried against 2 open blocker(s)'],
    [
      'a check that was never blocking',
      overrideOf([MEDIA_MISSING, { ...NO_OUTPUT, name: 'Outputs: something else' }]),
      'Outputs: no output window was blocking and is not carried',
    ],
    [
      'a cause rewritten on the way through',
      overrideOf([MEDIA_MISSING, { ...NO_OUTPUT, cause: 'the operator said it was fine' }]),
      'Outputs: no output window is carried with a cause it did not block for',
    ],
  ];

  for (const [name, override, problem] of cases) {
    it(`refuses ${name}`, () => {
      expect(overrideProblem(checklist, override)).toBe(`transition to Go Live: ${problem}`);
    });
  }

  it('accepts an override that carries every open blocker with the cause it blocked for', () => {
    expect(overrideProblem(checklist, overrideOf(checklist.blockers))).toBeUndefined();
  });
});

describe('the Operator override', () => {
  // Which Service, which run, and why. What was blocking is nowhere in here: that is the server's.
  const request = (serviceId: string): OverrideRequest => ({
    serviceId,
    runId: 'run-1',
    reason: 'The backup projector is on standby and the missing file is cosmetic',
  });

  it('carries every open blocking check, by name and with the cause it blocked for', async () => {
    const { preparation, serviceId } = await prepared();

    const outcome = await preparation.override(OPERATOR_SESSION, request(serviceId));

    expect(outcome.override.carried).toEqual([MEDIA_MISSING, NO_OUTPUT]);
    expect(outcome.override.operator).toBe(OPERATOR);
    expect(outcome.override.auditEntry).toBe(OVERRIDE_ACTION);
    expect(outcome.runLabel).toBe(LIVE_OVERRIDDEN_LABEL);
  });

  it('does not override on an empty reason', async () => {
    const { db, preparation, serviceId } = await prepared();

    for (const reason of ['', '   ']) {
      const error = await refused(preparation.override(OPERATOR_SESSION, { ...request(serviceId), reason }));
      expect(error.kind).toBe('reason');
    }
    expect(rows(db, RUN_EVENTS)).toHaveLength(0);
    expect(rows(db, AUDIT).filter((row) => row['action'] === OVERRIDE_ACTION)).toHaveLength(0);
  });

  // THR-11: the refusal is the server's, not the client's. None of these sessions is ever offered the
  // control, and every one of them is refused anyway when it asks for it directly. A guest and an output
  // window hold no permission at all — redeeming a capability answers with `canControl: false` and no
  // grants — and none of the three roles carries Control presentation for being that role.
  it('refuses every session without Control presentation, whether or not a client ever offered it', async () => {
    const { db, preparation, serviceId } = await prepared();
    const sessions: readonly (readonly [string, OperatorSession])[] = [
      ['an admin', sessionOf(accountOf('admin'))],
      ['an editor', sessionOf(accountOf('editor'))],
      ['a member', sessionOf(accountOf('member'))],
      ['a guest', { actor: 'guest:invited', permissions: [], correlationId: CORRELATION }],
      ['a stage display', { actor: 'capability:output', permissions: [], correlationId: CORRELATION }],
    ];

    for (const [who, session] of sessions) {
      const error = await refused(preparation.override(session, request(serviceId)));
      expect(error.kind, who).toBe('permission');
      expect(error.message).toContain(PRESENTATION_CONTROL);
    }
    expect(rows(db, RUN_EVENTS)).toHaveLength(0);
    expect(sessions.every(([, session]) => !session.permissions.includes(PRESENTATION_CONTROL))).toBe(true);
    expect(permissionsFor(accountOf('admin'))).toEqual([
      ACCOUNTS_MANAGE,
      'settings.manage',
      'layouts.manage',
      SERVICE_TEMPLATES_MANAGE,
      'media.manage',
      'services.manage',
      'content.edit',
      'catalogue.manage',
    ]);
  });

  // The other half of the same rule: the Operator is whoever was granted Control presentation, and the
  // grant is what decides it rather than the role the account happens to hold.
  it('accepts every session holding Control presentation, whatever role carries it', async () => {
    for (const role of ['admin', 'editor', 'member'] as const) {
      const { preparation, serviceId } = await prepared();

      const outcome = await preparation.override(sessionOf(accountOf(role, { controlPresentation: true })), request(serviceId));

      expect(outcome.runLabel, role).toBe(LIVE_OVERRIDDEN_LABEL);
      expect(outcome.override.carried, role).toEqual([MEDIA_MISSING, NO_OUTPUT]);
    }
  });

  // The checklist is the server's own observation, run through the same readiness the Service's state
  // produces for anyone asking. A request has nowhere to say what is open, and saying it anyway changes
  // nothing: the blocker a caller would have left out is carried into the run event and the trail.
  it('carries every blocker the server observes, even when the request claims fewer', async () => {
    const { db, preparation, serviceId } = await prepared();
    const smuggled = { ...request(serviceId), observed: { checks: [MEDIA_MISSING] } } as OverrideRequest;

    const outcome = await preparation.override(OPERATOR_SESSION, smuggled);

    expect(outcome.override.carried).toEqual([MEDIA_MISSING, NO_OUTPUT]);
    const [entry] = rows(db, AUDIT).filter((row) => row['action'] === OVERRIDE_ACTION);
    expect(String(entry?.['detail'])).toContain(NO_OUTPUT.name);
    expect(String(entry?.['detail'])).toContain('2 open blocker(s)');
  });

  it('leaves the warnings and the prepared manifest exactly as they were', async () => {
    const { db, preparation, serviceId } = await prepared();
    const before = structuredClone(rows(db, SNAPSHOTS));

    const outcome = await preparation.override(OPERATOR_SESSION, request(serviceId));
    const after = await preparation.readiness(CONTEXT, serviceId, { checks: [MEDIA_MISSING, NO_OUTPUT, ONE_TRANSLATION, REHEARSED] });

    expect(rows(db, SNAPSHOTS)).toEqual(before);
    expect(outcome.snapshot).toEqual((await preparation.prepared(CONTEXT, serviceId))?.snapshot);
    expect(after?.warnings).toEqual([ONE_TRANSLATION]);
    expect(after?.blockers).toEqual([MEDIA_MISSING, NO_OUTPUT]);
  });

  it('appends a run event and an audit entry naming the Operator, the reason and every check carried', async () => {
    const { db, preparation, serviceId } = await prepared();

    await preparation.override(OPERATOR_SESSION, request(serviceId));

    const [event] = rows(db, RUN_EVENTS);
    expect(event?.['kind']).toBe(OVERRIDE_ACTION);
    expect(event?.['runId']).toBe('run-1');
    expect(event?.['actor']).toBe(OPERATOR);
    expect(event?.['pinnedRevisions']).toEqual((await preparation.prepared(CONTEXT, serviceId))?.snapshot.pins);

    const [entry] = rows(db, AUDIT).filter((row) => row['action'] === OVERRIDE_ACTION);
    expect(entry?.['actor']).toBe(OPERATOR);
    expect(entry?.['subject']).toBe(`service:${serviceId}`);
    expect(entry?.['outcome']).toBe('allowed');
    expect(String(entry?.['detail'])).toContain('The backup projector is on standby');
    for (const check of [MEDIA_MISSING, NO_OUTPUT]) expect(String(entry?.['detail'])).toContain(check.name);
    expect(CATEGORY_OF[OVERRIDE_ACTION]).toBe('presentation');
  });

  it('reports the run as live overridden for its whole duration', async () => {
    const { db, preparation, serviceId } = await prepared();
    expect(await preparation.runLabel(CONTEXT, 'run-1')).toBe(LIVE_LABEL);

    await preparation.override(OPERATOR_SESSION, request(serviceId));
    expect(await preparation.runLabel(CONTEXT, 'run-1')).toBe(LIVE_OVERRIDDEN_LABEL);

    // A later event in the same run does not put the label back: the run was overridden, and stays so.
    await repositoriesOn(db)[RUN_EVENT_RECORD].append(CONTEXT, {
      _id: 'run-1#2', runId: 'run-1', sequence: 2, at: new Date(START).toISOString(), kind: 'slide.shown',
      pinnedRevisions: {}, actor: OPERATOR, correlationId: CORRELATION,
    });

    expect(await preparation.runLabel(CONTEXT, 'run-1')).toBe(LIVE_OVERRIDDEN_LABEL);
    expect(await preparation.runLabel(CONTEXT, 'run-2')).toBe(LIVE_LABEL);
  });

  it('refuses when nothing is open to override, and before anything is prepared', async () => {
    const clear = await prepared({ checks: [ONE_TRANSLATION] });
    const unprepared = harness();
    const service = await unprepared.services.create(EDITOR, DRAFT);

    expect((await refused(clear.preparation.override(OPERATOR_SESSION, request(clear.serviceId)))).kind).toBe('state');
    expect((await refused(unprepared.preparation.override(OPERATOR_SESSION, request(service.stamp.id)))).kind).toBe('state');
  });

  it('writes its trail through a record class with no update or delete path', async () => {
    const { db } = await prepared();

    expect(RECORDS.auditEvents.kind).toBe('append-only');
    expect(Object.keys(repositoriesOn(db).auditEvents).sort()).toEqual(['append', 'count', 'read', 'record']);
  });
});

describe('a record this code cannot read back', () => {
  it('refuses a Service or a manifest this code cannot read, rather than pinning a guess', async () => {
    const db = fakeDb();
    const preparation = preparationOn(db, { now: () => new Date(START).toISOString() });
    db.rows.set(RECORDS.services.collection, [{ _id: 'service-9#1', serviceId: 'service-9', sequence: 'first' }]);
    expect((await refused(preparation.prepare(CONTEXT, 'service-9', INPUTS))).kind).toBe('corrupt');

    db.rows.set(RECORDS.services.collection, [{ _id: 'service-9#1', serviceId: 'service-9', sequence: 1 }]);
    expect((await refused(preparation.prepare(CONTEXT, 'service-9', INPUTS))).kind).toBe('corrupt');

    db.rows.set(SNAPSHOTS, [
      { _id: 'service-9#1', serviceId: 'service-9', preparedAt: '2026-09-13T09:30:00.000Z', pins: {}, aspectRatio: '16:9', safeArea: {} },
    ]);
    expect((await refused(preparation.prepared(CONTEXT, 'service-9'))).kind).toBe('corrupt');
  });

  it('lets a write that failed for any other reason through as what it was', async () => {
    const built = harness();
    const service = await built.services.create(EDITOR, DRAFT);
    built.db.failOn = (): Error => new Error('the volume is full');

    await expect(built.preparation.prepare(CONTEXT, service.stamp.id, INPUTS)).rejects.toThrow('the volume is full');
  });
});
