import { afterEach, expect, it, vi } from 'vitest';

import { runContext } from './runs.js';
import { DEFAULT_SETTINGS } from './settings.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { RunEngineOptions } from './run-engine.js';
import type { RunRecord } from './runs.js';

const boot = vi.hoisted(() => ({
  options: undefined as RunEngineOptions | undefined,
  db: undefined as unknown,
  order: [] as string[],
  listen: vi.fn(async () => {}),
  command: vi.fn(),
}));
vi.mock('mongodb', () => ({ MongoClient: class {
  async connect() {}
  db() { return boot.db; }
} }));
vi.mock('./boot.js', () => ({
  checkReleasedContracts: () => {}, checkOwnSettingsMount: () => {}, checkCorpusBoundary: () => {},
  checkCorpusIsClosed: () => {}, checkSchema: () => {}, readSettingsText: () => '',
}));
vi.mock('./corpus.js', () => ({ probeCorpusIsClosed: async () => true }));
vi.mock('./migrations.js', () => ({ schemaStatus: async () => ({}) }));
vi.mock('./seed.js', () => ({ seedOn: () => ({ run: async () => {} }), seedContext: () => ({}) }));
vi.mock('./settings.js', async (original) => ({
  ...await original<typeof import('./settings.js')>(),
  loadSettings: () => ({ values: { ...DEFAULT_SETTINGS, mongoUrl: 'mongodb://localhost/test' }, sources: {}, path: '/tmp/settings.yaml' }),
}));
vi.mock('./static.js', () => ({ readWebBuild: () => undefined }));
vi.mock('./settings-admin.js', () => ({ settingsAdminOn: () => ({ watch: () => ({ close: () => {} }) }) }));
vi.mock('./app.js', () => ({ buildApp: () => ({ listen: boot.listen, log: { info: () => {} } }) }));
vi.mock('./run-engine.js', () => ({ runEngineOn: (options: RunEngineOptions) => {
  boot.options = options;
  return { command: boot.command, restore: async () => { boot.order.push('restore'); } };
} }));
vi.mock('./live.js', () => ({ serveLive: async (_app: unknown, options: { engine?: { command: unknown } }) => {
  expect(options.engine?.command).toBe(boot.command);
  boot.order.push('serve');
} }));

afterEach(() => { vi.restoreAllMocks(); });

it('restores before serving and derives a run deck from its original snapshot with repository read permissions', async () => {
  const db = fakeDb();
  boot.db = db;
  vi.spyOn(process, 'once').mockReturnValue(process);
  await import('./main.js');
  expect(boot.order).toEqual(['restore', 'serve']);
  expect(boot.listen).toHaveBeenCalledOnce();
  const options = boot.options!;
  const context = runContext('account:operator', 'test:main');
  const run = { runId: 'run-1', snapshotId: 'missing' } as RunRecord;
  await expect(options.deck(context, run)).rejects.toThrow('missing is not a manifest');
  db.rows.get('prepared_snapshots')?.push({
    _id: 'snapshot-1', serviceId: 'service-1', preparedAt: '2026-09-23T09:00:00.000Z',
    pins: { service: 'service@1', content: 'content@1', slideLayout: 'layout@1', serviceTemplate: 'template@1', settings: 'settings@1', media: 'media@1', corpus: 'corpus@1' },
    aspectRatio: '16:9', safeArea: { top: 0, right: 0, bottom: 0, left: 0, unit: 'percent' }, generatedSlides: [],
  });
  const deck = await options.deck(context, { ...run, snapshotId: 'snapshot-1' });
  expect(deck.snapshotId).toBe('snapshot-1');
  expect(deck.pinnedRevisions.corpus).toBe('corpus@1');
  expect(deck.items).toEqual([]);
});
