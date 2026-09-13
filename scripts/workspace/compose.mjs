// Reads the Compose stacks the way an operator would have to, and refuses the arrangements that look
// fine in the file and fail at three in the morning. FND-06 asks for a development environment that
// starts MongoDB, the corpus, the application, the web development flow and the worker, and that every
// one of them is health-checked; T19 then made the application refuse a database whose schema version is
// not the one it was built for, so the migration has to have finished before the application starts.
// Both of those are statements about the Compose files, so they are read here rather than discovered by
// bringing the stack up and watching it hang.
//
// Two stacks, two different promises. The development stack keeps its data across a `down` and an `up`,
// because an operator who restarts it expects yesterday's work to still be there. The test stack keeps
// nothing a second run could find, because a test that sees the previous run's records is not a test.
// Both promises are about the same two paths, so they are named once, in PERSISTED_PATHS, and each stack
// is read against its own reading of them.
//
// Ports are the one place where the two stacks differ on purpose. The development stack publishes the
// application to the network, because the devices it has to be tried on are not this machine. The corpus
// is never published past loopback in either, because it is reachable from inside the deployment only.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { parse } from 'yaml';

import { fromRepoRoot } from './pipeline.mjs';

export const DEV_FILE = 'compose.dev.yaml';

export const TEST_FILE = 'compose.test.yaml';

/** What a development stack has to start for the environment to be the whole environment. */
export const REQUIRED_SERVICES = Object.freeze(['app', 'migrate', 'mongo', 'server', 'web', 'worker']);

/** The services that run once and exit, which is the opposite of what a healthcheck waits for. */
export const ONE_SHOT_SERVICES = Object.freeze(['migrate']);

/** The paths that hold records: durable in the development stack, and nowhere in the test stack. */
export const PERSISTED_PATHS = Object.freeze(['/data/db', '/data/holydeck']);

/** What may never be published past this machine, and the reason each one may not be. */
export const LOOPBACK_ONLY = Object.freeze({
  mongo: 'the records it holds answer from inside the deployment only',
  server: 'the corpus is reachable from inside the deployment only',
});

const LOOPBACK = /^(?:127\.0\.0\.1|\[::1\]):/u;

const oneShot = (name) => ONE_SHOT_SERVICES.includes(name);

const conditionWanted = (name) => (oneShot(name) ? 'service_completed_successfully' : 'service_healthy');

// The long mapping form is not used in these files; String() leaves it looking published to the world,
// which is the safe way for an unread form to fail.
const published = (port) => String(port);

const mountsOf = (service) =>
  (service.volumes ?? []).map((mount) => {
    const [source, target] = String(mount).split(':');
    return { source, target: target ?? '', named: !/^[.~/]/u.test(source) };
  });

const under = (target, path) => target === path || target.startsWith(`${path}/`);

// A tmpfs entry may carry mount options after the path, the way a test stack sizes one.
const tmpfsPath = (entry) => String(entry).split(':')[0];

/** Reads one Compose file into the shape the checks below read, and says so when it is not one. */
export function parseCompose(file, text) {
  const document = parse(text) ?? {};
  if (typeof document.services !== 'object' || document.services === null) {
    throw new Error(`${file}: defines no services`);
  }
  return {
    file,
    project: document.name,
    persistence: file === TEST_FILE ? 'ephemeral' : 'named-volumes',
    services: document.services,
    volumes: document.volumes ?? {},
  };
}

/** Everything wrong with one stack, in one list, each finding naming the file it is in. */
export function verifyStack(stack, dockerfiles) {
  const { file, services, volumes, persistence } = stack;
  const ephemeral = persistence === 'ephemeral';
  const findings = [];
  const say = (problem) => findings.push(`${file}: ${problem}`);

  for (const name of REQUIRED_SERVICES) if (services[name] === undefined) say(`starts no ${name}`);
  if (ephemeral && stack.project === undefined) {
    say('names no project of its own, so a test run would take over the development stack');
  }

  const mounted = new Set();
  for (const [name, service] of Object.entries(services).sort(([a], [b]) => a.localeCompare(b))) {
    const dockerfile = service.build?.dockerfile;
    if (oneShot(name)) {
      if (service.healthcheck !== undefined) {
        say(`${name} runs once and exits, so a healthcheck on it can only fail`);
      }
    } else if (service.healthcheck === undefined) {
      const checked = dockerfile !== undefined && /^HEALTHCHECK\b/mu.test(dockerfiles[dockerfile] ?? '');
      if (!checked) {
        say(
          dockerfile === undefined
            ? `${name} declares no healthcheck, and its image is not built here to declare one`
            : `${name} declares no healthcheck, and ${dockerfile} declares none either`,
        );
      }
    }

    if (service.image !== undefined && !/@sha256:|:[^:@/]+$/u.test(service.image.replace(/:latest$/u, ''))) {
      say(`${name} runs ${service.image}, which is whatever it was pulled on the day`);
    }

    const dependencies = service.depends_on ?? {};
    for (const dependency of Array.isArray(dependencies) ? dependencies : Object.keys(dependencies)) {
      const condition = Array.isArray(dependencies) ? undefined : dependencies[dependency]?.condition;
      if (services[dependency] === undefined) {
        say(`${name} waits for ${dependency}, which this stack does not start`);
        continue;
      }
      const wanted = conditionWanted(dependency);
      if (condition === undefined) {
        say(`${name} depends on ${dependency} with no condition, so it starts before ${dependency} is ready`);
      } else if (condition !== wanted) {
        const said =
          condition === 'service_healthy'
            ? `waits for ${dependency} to become healthy, but ${dependency} exits`
            : condition === 'service_completed_successfully'
              ? `waits for ${dependency} to finish, but ${dependency} keeps running`
              : `waits for ${dependency} with condition ${condition}, which says nothing about being ready`;
        say(`${name} ${said}; wait for ${wanted}`);
      }
    }

    for (const port of service.ports ?? []) {
      const spec = published(port);
      if (LOOPBACK.test(spec)) continue;
      if (ephemeral) {
        say(`${name} publishes ${spec} on every interface; a test stack answers this machine only`);
      } else if (LOOPBACK_ONLY[name] !== undefined) {
        say(`${name} publishes ${spec} on every interface; ${LOOPBACK_ONLY[name]}`);
      }
    }

    for (const mount of mountsOf(service)) {
      if (/settings\.yaml$/u.test(mount.target) || /settings\.yaml$/u.test(mount.source)) {
        say(
          `${name} mounts settings.yaml itself; mount the directory holding it, because replacing the file changes its inode`,
        );
      }
      if (!mount.named) continue;
      mounted.add(mount.source);
      if (volumes[mount.source] === undefined && !(mount.source in volumes)) {
        say(`${name} mounts ${mount.source}, which the stack does not declare`);
      }
      if (ephemeral && PERSISTED_PATHS.some((path) => under(mount.target, path))) {
        say(`${name} mounts ${mount.source}, so a second run would see what the first one left`);
      }
    }
  }

  if (services.app !== undefined && services.migrate !== undefined) {
    const waited = Array.isArray(services.app.depends_on) ? undefined : services.app.depends_on?.migrate;
    if (waited?.condition !== 'service_completed_successfully') {
      say('app starts without waiting for migrate, so it can serve a database at the wrong schema version');
    }
  }

  for (const volume of Object.keys(volumes)) {
    if (!mounted.has(volume)) say(`${volume} is declared and mounted by nothing`);
  }

  for (const path of PERSISTED_PATHS) {
    const tmpfs = Object.values(services).some((service) =>
      (service.tmpfs ?? []).some((entry) => under(tmpfsPath(entry), path)),
    );
    const kept = Object.values(services).some((service) =>
      mountsOf(service).some((mount) => mount.named && under(mount.target, path)),
    );
    if (ephemeral && !tmpfs) say(`${path} is not a tmpfs, so a test run writes it to disk`);
    if (!ephemeral && !kept) say(`nothing keeps ${path} across a down and up`);
  }

  if (services.app !== undefined && services.web !== undefined) {
    const built = new Set(mountsOf(services.web).filter((mount) => mount.named).map((mount) => mount.source));
    const served = mountsOf(services.app).some((mount) => mount.named && built.has(mount.source));
    if (!served) say('app serves a web client the web service does not build into a shared volume');
  }

  return findings;
}

/** Every stack read against its own promises, in one list. */
export function verifyCompose({ stacks, dockerfiles }) {
  return stacks.flatMap((stack) => verifyStack(stack, dockerfiles));
}

/** Reads what `docker compose ps --format json` said, and names whatever is not up. */
export function healthVerdicts(text) {
  const trimmed = text.trim();
  let rows;
  try {
    rows = trimmed.startsWith('[')
      ? JSON.parse(trimmed)
      : trimmed
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map((line) => JSON.parse(line));
  } catch {
    return ['docker compose ps did not answer with JSON'];
  }

  const found = new Map(rows.map((row) => [row.Service, row]));
  const problems = [];
  for (const name of REQUIRED_SERVICES) {
    const row = found.get(name);
    if (row === undefined) {
      problems.push(`${name} is not in the stack at all`);
    } else if (oneShot(name)) {
      if (row.State === 'running') problems.push(`${name} is still running rather than having finished`);
      else if (row.State !== 'exited') problems.push(`${name} is ${row.State} rather than having finished`);
      else if (row.ExitCode !== 0) {
        problems.push(`${name} exited ${row.ExitCode} rather than finishing successfully`);
      }
    } else if (row.State !== 'running') {
      problems.push(`${name} is ${row.State}, not running`);
    } else if (row.Health !== 'healthy') {
      problems.push(`${name} is running but ${row.Health === '' ? 'unchecked' : row.Health}, not healthy`);
    }
  }
  return problems;
}

/** The stacks and the Dockerfiles they build, as the repository has them now. */
export function readRepo() {
  const stacks = [DEV_FILE, TEST_FILE].map((file) =>
    parseCompose(file, readFileSync(fromRepoRoot(file), 'utf8')),
  );
  const dockerfiles = {};
  for (const stack of stacks) {
    for (const service of Object.values(stack.services)) {
      const file = service.build?.dockerfile;
      if (file === undefined || dockerfiles[file] !== undefined) continue;
      dockerfiles[file] = readFileSync(fromRepoRoot(file), 'utf8');
    }
  }
  return { stacks, dockerfiles };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = verifyCompose(readRepo());
  for (const problem of problems) console.error(problem);
  process.exit(problems.length === 0 ? 0 : 1);
}
