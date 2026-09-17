import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Db } from 'mongodb';

process.env.MONGOMS_VERSION ??= '8.0.4';

export const DATABASE = 'holydeck-test';

export interface TestMongo {
  db: Db;
  stop: () => Promise<void>;
}

/** A database where the product's own user holds exactly the privileges a record class declares. */
export interface RestrictedMongo extends TestMongo {
  /** The same database reached as root, for the setup and teardown the restricted user may not do. */
  readonly root: Db;
}

const ROOT = { username: 'test-root', password: 'test-root' };
const APP = { username: 'test-app', password: 'test-app' };

/**
 * Starts a database with authentication on and grants the product's user one role: the actions the record
 * class names on the collection it names, and nothing else. A test can then ask the database itself what
 * this product is allowed to do to history, rather than asking the code that is supposed to be careful.
 */
export async function startRestrictedMongo(privileges: {
  readonly collection: string;
  readonly actions: readonly string[];
}): Promise<RestrictedMongo> {
  const mongod = await MongoMemoryServer.create({
    auth: { enable: true, customRootName: ROOT.username, customRootPwd: ROOT.password },
  });
  const root = new MongoClient(mongod.getUri(), { auth: ROOT, authSource: 'admin', ignoreUndefined: true });
  await root.connect();
  const database = root.db(DATABASE);
  await database.command({
    createRole: 'appendOnly',
    privileges: [
      { resource: { db: DATABASE, collection: privileges.collection }, actions: [...privileges.actions] },
    ],
    roles: [],
  });
  await database.command({
    createUser: APP.username,
    pwd: APP.password,
    roles: [{ role: 'appendOnly', db: DATABASE }],
  });
  const client = new MongoClient(mongod.getUri(), { auth: APP, authSource: DATABASE, ignoreUndefined: true });
  await client.connect();
  let stopped = false;
  return {
    db: client.db(DATABASE),
    root: database,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await client.close();
      await root.close();
      await mongod.stop();
    },
  };
}

export async function startTestMongo(): Promise<TestMongo> {
  const mongod = await MongoMemoryServer.create();
  const client = new MongoClient(mongod.getUri(), { ignoreUndefined: true });
  await client.connect();
  let stopped = false;
  return {
    db: client.db(DATABASE),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await client.close();
      await mongod.stop();
    },
  };
}
