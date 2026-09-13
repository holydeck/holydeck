// A worker process the restart test can kill. It claims one job of one kind through the built queue, in a
// process of its own, and then either stops between the claim and the result — the way a machine losing
// power does — or finishes the job the way a worker that came back does.
//
// It is spawned rather than imported on purpose: a restart mid-job cannot be simulated in the process
// running the assertions, because the lease the test is about is held by an operating-system process that
// has to really stop while holding it.

import { queueDb, queueOn, workerContext } from '@holydeck/app/queue';
import { MongoClient } from 'mongodb';

const [url, database, worker, kind, leaseMs, mode] = process.argv.slice(2);

if (
  url === undefined ||
  database === undefined ||
  worker === undefined ||
  kind === undefined ||
  leaseMs === undefined ||
  mode === undefined
) {
  throw new Error('usage: restart-fixture.ts <mongo-url> <database> <worker> <kind> <lease-ms> <die|finish>');
}

const client = new MongoClient(url);
await client.connect();

const queue = queueOn(queueDb(client.db(database)), {
  now: () => new Date().toISOString(),
  leaseMs: Number(leaseMs),
});
const context = workerContext(`restart-${worker}`);

const job = await queue.claim(context, { worker, kinds: [kind] });
if (job === undefined) {
  process.stdout.write('there was no job to claim\n');
  await client.close();
  process.exit(3);
}

process.stdout.write(`claimed ${job.id} on attempt ${job.attempt}\n`);

if (mode === 'die') {
  // Not a stop: no signal handler runs, nothing is written back, and the lease this process is holding
  // outlives it. That is the failure the queue has to recover from on its own.
  process.kill(process.pid, 'SIGKILL');
} else {
  await queue.succeed(context, { worker, id: job.id });
  process.stdout.write(`finished ${job.id}\n`);
  await client.close();
}
