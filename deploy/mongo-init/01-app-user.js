// Runs once, only against a fresh mongo-data volume — docker-entrypoint-initdb.d scripts never
// re-run against one that already has data. Creates the least-privilege application user every
// other service connects as; HOLYDECK_MONGO_PASSWORD is this container's own environment,
// set by whichever compose file started it (see compose.yaml's mongo service).
const password = process.env.HOLYDECK_MONGO_PASSWORD;
if (!password) {
  throw new Error('HOLYDECK_MONGO_PASSWORD is required to create the application user');
}
db = db.getSiblingDB('holydeck');
db.createUser({
  user: 'holydeck',
  pwd: password,
  // readWrite for normal operation; dbAdmin because migrate.js changes schema/indexes. Also granted
  // on 'holydeck__restore_rehearsal' (apps/app/src/restores.ts's rehearsalDatabaseName('holydeck')) —
  // the weekly restore rehearsal and restore-apply's own precondition both write there, and without
  // this grant they fail Unauthorized the moment auth is enforced.
  roles: [
    { role: 'readWrite', db: 'holydeck' },
    { role: 'dbAdmin', db: 'holydeck' },
    { role: 'readWrite', db: 'holydeck__restore_rehearsal' },
    { role: 'dbAdmin', db: 'holydeck__restore_rehearsal' },
  ],
});
