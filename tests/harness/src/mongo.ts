// The database the harness stores into. By default it starts one of its own, in memory, so a run leaves
// nothing behind and two runs cannot see each other's records. A deployment's database can be handed in
// instead — that is how this suite can be pointed at the Compose test stack rather than at itself.

import { MongoMemoryReplSet } from 'mongodb-memory-server';

/** The same version the application's own integration test pins, so one cached binary serves both. */
export const MONGO_VERSION = '8.0.4';

export interface HarnessMongo {
  /** The address, without a database name: each service in the stack names its own. */
  readonly base: string;
  stop(): Promise<void>;
}

export async function mongoFor(provided: string | undefined): Promise<HarnessMongo> {
  if (provided !== undefined) return { base: provided, stop: async () => undefined };
  // A single-node replica set, not a standalone server: `apps/app/src/backups.ts` reads its archive
  // inside a real Mongo transaction, the same as production, and only a replica set member honours
  // one — the same reason `apps/app/test/helpers/mongo.ts` keeps its own `startTestMongoReplicaSet()`.
  const server = await MongoMemoryReplSet.create({
    binary: { version: MONGO_VERSION },
    replSet: { storageEngine: 'wiredTiger', count: 1 },
  });
  return { base: server.getUri(), stop: () => server.stop().then(() => undefined) };
}
