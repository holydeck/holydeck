// A worker process for the Mongo-interruption failure-injection test. It claims one job, waits a
// short, fixed moment — long enough that the test controlling it has already stopped MongoDB by
// the time this process attempts its next write (see the test file's Ruling on this exact wait) —
// and then calls the queue the ordinary way. Nothing here retries or reconnects by hand: recovering
// from the interruption is the MongoDB driver's own job, not this process's, and that is exactly
// what this fixture exists to prove rather than assume.
//
// It is spawned rather than imported for the same reason `restart-fixture.ts` is: the process
// holding the lease has to be a real, separate operating-system process for MongoDB to really go
// away underneath it while it holds that lease.

import { queueDb, queueOn, workerContext } from '@holydeck/app/queue';
import { MongoClient } from 'mongodb';

const [url, database, worker, kind, leaseMs] = process.argv.slice(2);

if (
  url === undefined ||
  database === undefined ||
  worker === undefined ||
  kind === undefined ||
  leaseMs === undefined
) {
  throw new Error('usage: mongo-interruption-fixture.ts <mongo-url> <database> <worker> <kind> <lease-ms>');
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Generous on purpose: this process's own operations have to survive real MongoDB downtime, not
// merely a slow reply.
const client = new MongoClient(url, { serverSelectionTimeoutMS: 20_000 });
await client.connect();

const queue = queueOn(queueDb(client.db(database)), {
  now: () => new Date().toISOString(),
  leaseMs: Number(leaseMs),
});
const context = workerContext(`mongo-interruption-${worker}`);

const job = await queue.claim(context, { worker, kinds: [kind] });
if (job === undefined) {
  process.stdout.write('there was no job to claim\n');
  await client.close();
  process.exit(3);
}

process.stdout.write(`claimed ${job.id} on attempt ${job.attempt}\n`);

// The test stops MongoDB right after seeing the line above. This wait is what makes that race
// reliable: without it, a fast local claim-then-succeed could both land before the test's own
// stop() call ever runs, and the interruption this fixture exists to survive would never happen.
await sleep(500);

await queue.succeed(context, { worker, id: job.id });
process.stdout.write(`finished ${job.id}\n`);
await client.close();
