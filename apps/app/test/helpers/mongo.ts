import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Db } from 'mongodb';

process.env.MONGOMS_VERSION ??= '8.0.4';

export interface TestMongo {
  db: Db;
  stop: () => Promise<void>;
}

export async function startTestMongo(): Promise<TestMongo> {
  const mongod = await MongoMemoryServer.create();
  const client = new MongoClient(mongod.getUri());
  await client.connect();
  let stopped = false;
  return {
    db: client.db('holydeck-test'),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await client.close();
      await mongod.stop();
    },
  };
}
