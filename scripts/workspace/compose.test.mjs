import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ONE_SHOT_SERVICES,
  PERSISTED_PATHS,
  REQUIRED_SERVICES,
  healthVerdicts,
  parseCompose,
  readRepo,
  verifyCompose,
  verifyStack,
} from './compose.mjs';

const CHECK = { test: ['CMD', 'true'], interval: '10s', timeout: '5s', retries: 6 };

const DOCKERFILES = {
  'apps/app/Dockerfile': 'FROM node:24-slim\nCMD ["node", "/srv/app/dist/main.js"]\n',
  'apps/corpus/Dockerfile': 'FROM node:24-slim\nHEALTHCHECK CMD node -e "fetch()"\nCMD ["node", "dist/server.js"]\n',
  'apps/web/Dockerfile.dev': 'FROM node:24-slim\nCMD ["pnpm", "dev"]\n',
};

const dev = () => ({
  file: 'compose.dev.yaml',
  project: undefined,
  persistence: 'named-volumes',
  services: {
    mongo: {
      image: 'mongo:8',
      healthcheck: CHECK,
      ports: ['127.0.0.1:27017:27017'],
      volumes: ['mongo-dev-data:/data/db'],
    },
    server: {
      build: { dockerfile: 'apps/corpus/Dockerfile' },
      ports: ['127.0.0.1:3000:3000'],
      depends_on: { mongo: { condition: 'service_healthy' } },
    },
    migrate: {
      build: { dockerfile: 'apps/app/Dockerfile' },
      depends_on: { mongo: { condition: 'service_healthy' } },
    },
    app: {
      build: { dockerfile: 'apps/app/Dockerfile' },
      healthcheck: CHECK,
      ports: ['127.0.0.1:3100:3100'],
      volumes: ['holydeck-dev-data:/data/holydeck', 'web-dist:/srv/web/dist:ro'],
      depends_on: {
        migrate: { condition: 'service_completed_successfully' },
        server: { condition: 'service_healthy' },
        web: { condition: 'service_healthy' },
      },
    },
    web: {
      build: { dockerfile: 'apps/web/Dockerfile.dev' },
      healthcheck: CHECK,
      volumes: ['./apps/web/src:/repo/apps/web/src:ro', 'web-dist:/repo/apps/web/dist'],
    },
    worker: {
      build: { dockerfile: 'apps/app/Dockerfile' },
      healthcheck: CHECK,
      volumes: ['holydeck-dev-data:/data/holydeck'],
      depends_on: { migrate: { condition: 'service_completed_successfully' } },
    },
  },
  volumes: { 'mongo-dev-data': null, 'holydeck-dev-data': null, 'web-dist': null },
});

const ephemeral = () => {
  const stack = dev();
  return {
    ...stack,
    file: 'compose.test.yaml',
    project: 'holydeck-test',
    persistence: 'ephemeral',
    services: {
      ...stack.services,
      mongo: { ...stack.services.mongo, volumes: undefined, tmpfs: ['/data/db'] },
      app: { ...stack.services.app, volumes: ['web-dist:/srv/web/dist:ro'], tmpfs: ['/data/holydeck'] },
      worker: { ...stack.services.worker, volumes: undefined, tmpfs: ['/data/holydeck'] },
      web: { ...stack.services.web, volumes: ['web-dist:/repo/apps/web/dist'] },
    },
    volumes: { 'web-dist': null },
  };
};

const only = (stack) => verifyStack(stack, DOCKERFILES);

test('the contract names the services a development stack has to start', () => {
  assert.deepEqual([...REQUIRED_SERVICES], ['app', 'migrate', 'mongo', 'server', 'web', 'worker']);
  assert.deepEqual([...ONE_SHOT_SERVICES], ['migrate']);
  assert.deepEqual([...PERSISTED_PATHS], ['/data/db', '/data/holydeck']);
});

test('a stack that keeps every rule has nothing to report', () => {
  assert.deepEqual(only(dev()), []);
  assert.deepEqual(only(ephemeral()), []);
});

test('names a service the stack does not start', () => {
  const stack = dev();
  delete stack.services.worker;
  assert.deepEqual(only(stack), ['compose.dev.yaml: starts no worker']);
});

test('refuses a long-running service whose health nothing checks', () => {
  const stack = dev();
  delete stack.services.app.healthcheck;
  assert.deepEqual(only(stack), [
    'compose.dev.yaml: app declares no healthcheck, and apps/app/Dockerfile declares none either',
  ]);
});

test('accepts a service whose image declares the check, which is where the corpus declares its own', () => {
  assert.deepEqual(only(dev()).filter((problem) => problem.includes('server')), []);
});

test('refuses a healthcheck on a service that is meant to exit', () => {
  const stack = dev();
  stack.services.migrate.healthcheck = CHECK;
  assert.deepEqual(only(stack), [
    'compose.dev.yaml: migrate runs once and exits, so a healthcheck on it can only fail',
  ]);
});

test('refuses a dependency the stack does not define', () => {
  const stack = dev();
  stack.services.app.depends_on.cache = { condition: 'service_healthy' };
  assert.deepEqual(only(stack), ['compose.dev.yaml: app waits for cache, which this stack does not start']);
});

test('refuses the list form, which starts a service before the one it needs is ready', () => {
  const stack = dev();
  stack.services.server.depends_on = ['mongo'];
  assert.deepEqual(only(stack), [
    'compose.dev.yaml: server depends on mongo with no condition, so it starts before mongo is ready',
  ]);
});

test('refuses waiting for health from a service that exits instead of becoming healthy', () => {
  const stack = dev();
  stack.services.app.depends_on.migrate = { condition: 'service_healthy' };
  assert.deepEqual(only(stack), [
    'compose.dev.yaml: app waits for migrate to become healthy, but migrate exits; wait for service_completed_successfully',
    'compose.dev.yaml: app starts without waiting for migrate, so it can serve a database at the wrong schema version',
  ]);
});

test('refuses waiting for a long-running service to finish, because it never does', () => {
  const stack = dev();
  stack.services.app.depends_on.server = { condition: 'service_completed_successfully' };
  assert.deepEqual(only(stack), [
    'compose.dev.yaml: app waits for server to finish, but server keeps running; wait for service_healthy',
  ]);
});

test('refuses an application that starts without the migration, which T19 makes it refuse to serve', () => {
  const stack = dev();
  delete stack.services.app.depends_on.migrate;
  assert.deepEqual(only(stack), [
    'compose.dev.yaml: app starts without waiting for migrate, so it can serve a database at the wrong schema version',
  ]);
});

test('refuses a corpus published to more than this machine', () => {
  const stack = dev();
  stack.services.server.ports = ['3000:3000'];
  assert.deepEqual(only(stack), [
    'compose.dev.yaml: server publishes 3000:3000 on every interface; the corpus is reachable from inside the deployment only',
  ]);
});

test('refuses a database published past this machine, whichever stack it is in', () => {
  const stack = dev();
  stack.services.mongo.ports = ['27017:27017'];
  assert.deepEqual(only(stack), [
    'compose.dev.yaml: mongo publishes 27017:27017 on every interface; the records it holds answer from inside the deployment only',
  ]);
});

test('reads a tmpfs that carries mount options, which is how a test stack sizes one', () => {
  const stack = ephemeral();
  stack.services.mongo.tmpfs = ['/data/db:size=1g,mode=1777'];
  assert.deepEqual(only(stack), []);
});

test('refuses an image-only service that nothing checks, because no Dockerfile here can declare it', () => {
  const stack = dev();
  delete stack.services.mongo.healthcheck;
  assert.deepEqual(only(stack), [
    'compose.dev.yaml: mongo declares no healthcheck, and its image is not built here to declare one',
  ]);
});

test('refuses mounting the settings file itself, because an atomic replace changes the inode', () => {
  const stack = dev();
  stack.services.app.volumes.push('./settings.yaml:/data/holydeck/config/settings.yaml:ro');
  assert.deepEqual(only(stack), [
    'compose.dev.yaml: app mounts settings.yaml itself; mount the directory holding it, because replacing the file changes its inode',
  ]);
});

test('refuses a named volume the stack never declares', () => {
  const stack = dev();
  stack.services.worker.volumes = ['holydeck-spool:/data/holydeck'];
  assert.deepEqual(only(stack), [
    'compose.dev.yaml: worker mounts holydeck-spool, which the stack does not declare',
  ]);
});

test('refuses a declared volume nothing mounts', () => {
  const stack = dev();
  stack.volumes['media-dev-data'] = null;
  assert.deepEqual(only(stack), ['compose.dev.yaml: media-dev-data is declared and mounted by nothing']);
});

test('refuses a development stack that loses the durable records on a restart', () => {
  const stack = dev();
  stack.services.mongo.volumes = undefined;
  assert.deepEqual(only(stack), [
    'compose.dev.yaml: mongo-dev-data is declared and mounted by nothing',
    'compose.dev.yaml: nothing keeps /data/db across a down and up',
  ]);
});

test('refuses an application serving a client the web service does not build', () => {
  const stack = dev();
  stack.services.app.volumes = ['holydeck-dev-data:/data/holydeck'];
  assert.deepEqual(only(stack), [
    'compose.dev.yaml: app serves a web client the web service does not build into a shared volume',
  ]);
});

test('refuses an unpinned image, because a development stack is meant to reproduce', () => {
  const stack = dev();
  stack.services.mongo.image = 'mongo:latest';
  assert.deepEqual(only(stack), [
    'compose.dev.yaml: mongo runs mongo:latest, which is whatever it was pulled on the day',
  ]);
});

test('refuses a test stack that keeps anything a second run would find', () => {
  const stack = ephemeral();
  stack.services.mongo = { ...stack.services.mongo, tmpfs: undefined, volumes: ['mongo-test-data:/data/db'] };
  stack.volumes['mongo-test-data'] = null;
  assert.deepEqual(only(stack), [
    'compose.test.yaml: mongo mounts mongo-test-data, so a second run would see what the first one left',
    'compose.test.yaml: /data/db is not a tmpfs, so a test run writes it to disk',
  ]);
});

test('refuses a test stack that shares a project name with the development one', () => {
  const stack = ephemeral();
  stack.project = undefined;
  assert.deepEqual(only(stack), [
    'compose.test.yaml: names no project of its own, so a test run would take over the development stack',
  ]);
});

test('refuses a test stack that publishes a port to the network', () => {
  const stack = ephemeral();
  stack.services.app.ports = ['3100:3100'];
  assert.deepEqual(only(stack), [
    'compose.test.yaml: app publishes 3100:3100 on every interface; a test stack answers this machine only',
  ]);
});

test('reads a stack out of YAML, including the forms compose allows', () => {
  const stack = parseCompose(
    'compose.test.yaml',
    [
      'name: holydeck-test',
      'services:',
      '  mongo:',
      '    image: mongo:8',
      '    tmpfs:',
      '      - /data/db',
      '    depends_on:',
      '      - server',
      'volumes:',
      '  web-dist:',
      '',
    ].join('\n'),
  );

  assert.equal(stack.file, 'compose.test.yaml');
  assert.equal(stack.project, 'holydeck-test');
  assert.equal(stack.persistence, 'ephemeral');
  assert.deepEqual(stack.services.mongo.tmpfs, ['/data/db']);
  assert.deepEqual(stack.services.mongo.depends_on, ['server']);
  assert.deepEqual(Object.keys(stack.volumes), ['web-dist']);
});

test('reads the development stack as the one that has to persist', () => {
  assert.equal(parseCompose('compose.dev.yaml', 'services:\n  app: {}\n').persistence, 'named-volumes');
});

test('refuses a compose file that is not a compose file', () => {
  assert.throws(() => parseCompose('compose.dev.yaml', 'just a line'), /compose\.dev\.yaml: defines no services/u);
});

test('every service in the stack is health-gated, read out of the repository as it stands', () => {
  assert.deepEqual(verifyCompose(readRepo()), []);
});

test('reads a stack where every service is up and the migration finished', () => {
  const ps = [
    { Service: 'mongo', State: 'running', Health: 'healthy' },
    { Service: 'server', State: 'running', Health: 'healthy' },
    { Service: 'web', State: 'running', Health: 'healthy' },
    { Service: 'app', State: 'running', Health: 'healthy' },
    { Service: 'worker', State: 'running', Health: 'healthy' },
    { Service: 'migrate', State: 'exited', Health: '', ExitCode: 0 },
  ]
    .map((row) => JSON.stringify(row))
    .join('\n');

  assert.deepEqual(healthVerdicts(ps), []);
});

test('reads the same stack when docker answers with one array instead of a line each', () => {
  const ps = JSON.stringify([
    { Service: 'mongo', State: 'running', Health: 'healthy' },
    { Service: 'server', State: 'running', Health: 'healthy' },
    { Service: 'web', State: 'running', Health: 'healthy' },
    { Service: 'app', State: 'running', Health: 'healthy' },
    { Service: 'worker', State: 'running', Health: 'healthy' },
    { Service: 'migrate', State: 'exited', Health: '', ExitCode: 0 },
  ]);

  assert.deepEqual(healthVerdicts(ps), []);
});

test('names every service that is not up, and the migration that did not finish', () => {
  const ps = [
    { Service: 'mongo', State: 'running', Health: 'healthy' },
    { Service: 'server', State: 'running', Health: 'starting' },
    { Service: 'web', State: 'running', Health: 'unhealthy' },
    { Service: 'app', State: 'exited', Health: '', ExitCode: 1 },
    { Service: 'migrate', State: 'exited', Health: '', ExitCode: 2 },
  ]
    .map((row) => JSON.stringify(row))
    .join('\n');

  assert.deepEqual(healthVerdicts(ps), [
    'app is exited, not running',
    'migrate exited 2 rather than finishing successfully',
    'server is running but starting, not healthy',
    'web is running but unhealthy, not healthy',
    'worker is not in the stack at all',
  ]);
});

test('names a migration still running, because a one-shot service that parks is a hung stack', () => {
  const ps = [
    { Service: 'mongo', State: 'running', Health: 'healthy' },
    { Service: 'server', State: 'running', Health: 'healthy' },
    { Service: 'web', State: 'running', Health: 'healthy' },
    { Service: 'app', State: 'running', Health: 'healthy' },
    { Service: 'worker', State: 'running', Health: 'healthy' },
    { Service: 'migrate', State: 'running', Health: '' },
  ]
    .map((row) => JSON.stringify(row))
    .join('\n');

  assert.deepEqual(healthVerdicts(ps), ['migrate is still running rather than having finished']);
});

test('says so when docker did not answer with JSON at all', () => {
  assert.deepEqual(healthVerdicts('Cannot connect to the Docker daemon'), [
    'docker compose ps did not answer with JSON',
  ]);
});
