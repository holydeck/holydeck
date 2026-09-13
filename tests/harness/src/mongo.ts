// The database the harness stores into. By default it starts one of its own, in memory, so a run leaves
// nothing behind and two runs cannot see each other's records. A deployment's database can be handed in
// instead — that is how this suite can be pointed at the Compose test stack rather than at itself.

import { MongoMemoryServer } from 'mongodb-memory-server';

/** The same version the application's own integration test pins, so one cached binary serves both. */
export const MONGO_VERSION = '8.0.4';

export interface HarnessMongo {
  /** The address, without a database name: each service in the stack names its own. */
  readonly base: string;
  stop(): Promise<void>;
}

export async function mongoFor(provided: string | undefined): Promise<HarnessMongo> {
  if (provided !== undefined) return { base: provided, stop: async () => undefined };
  const server = await MongoMemoryServer.create({ binary: { version: MONGO_VERSION } });
  return { base: server.getUri(), stop: () => server.stop().then(() => undefined) };
}
