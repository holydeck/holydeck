# HolyDeck

[![CI](https://github.com/holydeck/holydeck/actions/workflows/ci.yml/badge.svg)](https://github.com/holydeck/holydeck/actions/workflows/ci.yml)
[![Release](https://github.com/holydeck/holydeck/actions/workflows/release.yml/badge.svg)](https://github.com/holydeck/holydeck/actions/workflows/release.yml)
[![npm version](https://img.shields.io/npm/v/%40holydeck%2Fcli)](https://www.npmjs.com/package/@holydeck/cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A full setup for Sunday — bible verses and song slides, from sermon prep to screen.

> **Status: early development.** The first release has shipped: the CLI is on npm as
> [`@holydeck/cli`](https://www.npmjs.com/package/@holydeck/cli) and the server is available as
> a container image at `ghcr.io/holydeck/corpus`. Prereleases are also published under the npm
> `next` dist-tag and the GHCR `:next` image tag for testing ahead of a stable release.

## What it does

- Turns a dated sermon file (the verses for the service) into clean, ready-to-paste
  slide text for any number of translations
- Keeps a local bible datastore, so Sunday never depends on the internet being up
- Serves the same data through a self-hostable server
- Presents verses and song slides live (planned)

To get started, see the [CLI readme](apps/cli/README.md).

More at [holydeck.faith](https://holydeck.faith).

## Development

Development, CI, releases, and the server image use Node 24.20.0. Run `nvm use` to select the
version pinned in `.nvmrc`. The published CLI supports Node >= 24.20.0 and < 25; revisit this
when Node 26 (the next LTS) enters the support window — see `MAINTENANCE.md` for the latest
checkpoint.

Running, restarting, rolling back a migration, and rotating a secret on a deployed instance are
covered in `MAINTENANCE.md`, not here — this section is about developing HolyDeck itself.

`main` is protected by a ruleset: no direct pushes, no force-push, no branch deletion, commits
must be signed, and `verify`, `docker / build`, `analyze`, `dependency-review` and `CodeQL` must
all pass before merging (repository admins can bypass this, reserved for the release commit —
see `RELEASING.md`). Everything else goes through a branch and a pull request:

```sh
git checkout -b my-change
# ...make changes, commit (signed)...
git push -u origin my-change
gh pr create --base main
```

Merge once every check is green.

### Checks

`pnpm install` installs the hooks. A commit runs the checks that read staged files, which is quick and
leaves the rest of the working tree alone: staging one hunk of a file and committing it keeps the hunk
that was not staged, even though the checks rewrite the file in between.

```sh
pnpm exec lint-staged          # what a commit runs
node scripts/verify/gate.mjs   # what a push runs: every required check, in order
```

The gate is one list, in `scripts/verify/gate.mjs`, and CI runs the same commands step for step. A test
holds the two together, so a check added to the gate cannot be a check CI quietly skips. `git push
--no-verify` skips the hook; CI does not.

The browser suite drives a real Chromium, which each machine downloads once:

```sh
pnpm --filter @holydeck/harness exec playwright install chromium
pnpm test:e2e   # the client on a desktop, a tablet and a phone
```

`tests/harness` also holds the integration suite `pnpm turbo run test` runs: it starts a MongoDB of its
own, the corpus, the migration, the application and the worker, reaches all four through the outside of
them, and fails if a run never touched one of them.

### Running the stack locally

`compose.dev.yaml` builds everything from this checkout — the corpus server, the application, the
web client's watching build, the worker, the migration that runs before any of them serves, and the
MongoDB they store into — so the CLI and the client can be tested against real services without
deploying anything:

```sh
pnpm dev:server        # build from the working tree, serve on http://localhost:3000
pnpm dev:server:down   # stop it and delete the volumes
```

Every service is health-checked, so `docker compose -f compose.dev.yaml up --build --wait app corpus
web worker` comes back only once the stack is usable rather than merely started. The application
answers `/health`, the corpus declares its check in its own image, and the worker serves no HTTP at
all: its health is the heartbeat it writes, which it stops writing when the data directory it needs
goes away.

Editing `apps/web/src` rebuilds the client in place — the web service watches the mounted source and
writes into the volume the application serves. Editing anything else means building the images again.
A watching build survives a compile error, so the build records whether it worked and the service is
unhealthy until it does.

Records live in named volumes: `down` and `up` again finds the same database, and `down -v` is what
throws it away. `compose.test.yaml` is the same services arranged to remember nothing — its own
project, tmpfs instead of volumes, loopback ports of its own — so a test run starts from an empty
database and can run beside the development stack.

For the published deployment stack, `HOLYDECK_VERSION` selects the image tag `compose.yaml` pulls
for the corpus and the app, worker, and migration services. It defaults to `latest` when unset;
set it to `next` to track the prerelease channel. See `.env.example` for every variable
`compose.yaml` reads. The development and test stacks always build from the working tree instead.

```sh
pnpm verify:compose   # read both Compose files: health gates, wait conditions, what persists
pnpm verify:stack     # bring both stacks up and read what they did (slow: it builds images)
```

Every start rebuilds, so the container always runs the current code. The corpus requires a
credential and publishes on loopback only, the way a deployment runs it, so the CLI sends the
dev credential with every request:

```sh
curl localhost:3000/health
HOLYDECK_SERVER_TOKEN=dev-corpus-token-not-a-secret \
  node apps/cli/dist/cli.js get "PSA 118:24" --server-url http://localhost:3000
```

The application answers on <http://localhost:3100>, on every interface, because the phones and
tablets it has to be tried on are not this machine. It serves the web client from its own origin and
reads the corpus over the internal network, which is the only way anything reaches the library.

The corpus syncs through the Chromium in its own image, so `POST /api/v1/translations/KJV/sync`
works from the dev stack too. `apps/corpus/compose.example.yaml` is the deployment example
instead: it pulls the published image rather than building one.

### Syncing and reporting against a server

Every `sync`/`stats` invocation runs against the local datastore unless `--server-url` (or
`HOLYDECK_SERVER_URL`) points it at a corpus server, in which case the CLI drives that server's
sync jobs and reports instead of touching disk:

```sh
export HOLYDECK_SERVER_TOKEN=<admin-token>
node apps/cli/dist/cli.js sync KJV --server-url https://holydeck.example.com
node apps/cli/dist/cli.js sync status KJV --server-url https://holydeck.example.com
node apps/cli/dist/cli.js stats --server-url https://holydeck.example.com
```

`sync` starts (or attaches to an already-running) job and polls it to completion, printing
`[ABBR] done/total` progress lines. Every server-mode call — `sync`, `sync status` and `stats`
alike — requires the admin token (`HOLYDECK_SERVER_TOKEN`); without it, the server refuses with a
`server_admin_token_required` error naming the missing variable. `--dry-run` is local-only and is
refused against a server.

## License

[MIT](LICENSE)
