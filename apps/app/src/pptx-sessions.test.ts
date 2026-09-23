import { describe, expect, it } from 'vitest';

import { PPTX_SESSION_PERMISSIONS, pptxSessionContext, pptxSessionsOn } from './pptx-sessions.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { PptxImportResult } from './pptx-import.js';
import type { PptxReviewedBlock } from './pptx-review.js';
import type { PptxSessionStore } from './pptx-sessions.js';
import type { FakeDb } from '../test/helpers/fake-db.js';

const START = Date.parse('2026-09-23T09:00:00.000Z');

const DAY_MS = 24 * 60 * 60 * 1000;

const ALICE = `account:${'A'.repeat(22)}`;

const BOB = `account:${'B'.repeat(22)}`;

const SAMPLE_RESULT: PptxImportResult = {
  slides: [{ textBlocks: ['Amazing grace'], media: [] }],
  skippedMedia: [],
  provenance: { title: 'Sermon' },
};

const REVIEWED: readonly PptxReviewedBlock[] = [
  { slideIndex: 0, blockIndex: 0, label: { id: 'label-1', name: 'Verse' }, at: '2026-09-23T09:05:00.000Z', by: ALICE },
];

const store = (now: () => string): { db: FakeDb; sessions: PptxSessionStore } => {
  const db = fakeDb();
  return { db, sessions: pptxSessionsOn(db, { now, newId: () => 'session-1' }) };
};

describe('a PPTX import session', () => {
  it('creates a session and reads it back for its own actor', async () => {
    const { sessions } = store(() => new Date(START).toISOString());
    const context = pptxSessionContext(ALICE, 'req-1');

    const created = await sessions.create(context, { fileName: 'sermon.pptx', result: SAMPLE_RESULT });

    expect(created.id).toBe('session-1');
    expect(created.actor).toBe(ALICE);
    expect(created.fileName).toBe('sermon.pptx');
    expect(created.slides).toEqual(SAMPLE_RESULT.slides);
    await expect(sessions.get(context, created.id)).resolves.toEqual(created);
  });

  it("answers undefined for another actor's session", async () => {
    const { sessions } = store(() => new Date(START).toISOString());
    const created = await sessions.create(
      pptxSessionContext(ALICE, 'req-1'),
      { fileName: 'sermon.pptx', result: SAMPLE_RESULT },
    );

    const asBob = pptxSessionContext(BOB, 'req-2');
    await expect(sessions.get(asBob, created.id)).resolves.toBeUndefined();
  });

  it('answers undefined for an expired session without deleting the underlying rows', async () => {
    const db = fakeDb();
    const first = pptxSessionsOn(db, { now: () => new Date(START).toISOString(), newId: () => 'session-1' });
    const context = pptxSessionContext(ALICE, 'req-1');
    const created = await first.create(context, { fileName: 'sermon.pptx', result: SAMPLE_RESULT });

    const later = pptxSessionsOn(db, { now: () => new Date(START + DAY_MS + 60 * 60 * 1000).toISOString() });

    await expect(later.get(context, created.id)).resolves.toBeUndefined();
    expect(db.rows.get('pptx_import_sessions')).toHaveLength(1);
  });

  it('review() appends reviewed and reviewedAt without losing the original slides', async () => {
    const { sessions } = store(() => new Date(START).toISOString());
    const context = pptxSessionContext(ALICE, 'req-1');
    const created = await sessions.create(context, { fileName: 'sermon.pptx', result: SAMPLE_RESULT });

    const reviewed = await sessions.review(context, created.id, REVIEWED);

    expect(reviewed?.slides).toEqual(SAMPLE_RESULT.slides);
    expect(reviewed?.reviewed).toEqual(REVIEWED);
    expect(reviewed?.reviewedAt).toBe(new Date(START).toISOString());
  });

  it('discard() makes the session unreadable', async () => {
    const { sessions } = store(() => new Date(START).toISOString());
    const context = pptxSessionContext(ALICE, 'req-1');
    const created = await sessions.create(context, { fileName: 'sermon.pptx', result: SAMPLE_RESULT });

    await expect(sessions.discard(context, created.id)).resolves.toBe(true);
    await expect(sessions.get(context, created.id)).resolves.toBeUndefined();
  });

  it('names its own permissions after its record class', () => {
    expect(PPTX_SESSION_PERMISSIONS).toEqual({ read: 'pptxImportSessions.read', append: 'pptxImportSessions.append' });
  });
});
