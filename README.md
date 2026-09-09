# HolyDeck

[![CI](https://github.com/holydeck/holydeck/actions/workflows/ci.yml/badge.svg)](https://github.com/holydeck/holydeck/actions/workflows/ci.yml)
[![Release](https://github.com/holydeck/holydeck/actions/workflows/release.yml/badge.svg)](https://github.com/holydeck/holydeck/actions/workflows/release.yml)
[![npm version](https://img.shields.io/npm/v/%40holydeck%2Fcli)](https://www.npmjs.com/package/@holydeck/cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A full setup for Sunday — bible verses and song slides, from sermon prep to screen.

> **Status: early development.** The first release has shipped: the CLI is on npm as
> [`@holydeck/cli`](https://www.npmjs.com/package/@holydeck/cli) and the server is available as
> a container image at `ghcr.io/holydeck/server`.

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
when Node 26 (the next LTS) enters the support window.

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

### Running the server locally

`compose.dev.yaml` builds the server image from this checkout and starts it with a MongoDB, so
the CLI can be tested against a real server without deploying anything:

```sh
pnpm dev:server        # build from the working tree, serve on http://localhost:3000
pnpm dev:server:down   # stop it and delete the database volume
```

Every start rebuilds, so the container always runs the current code. Check it with
`curl localhost:3000/health`, then point the CLI at it:

```sh
node apps/cli/dist/cli.js get "PSA 118:24" --server-url http://localhost:3000
```

The server syncs through the Chromium in its own image, so `POST /api/v1/translations/KJV/sync`
works from the dev stack too. `apps/server/compose.example.yaml` is the deployment example
instead: it pulls the published image rather than building one.

## License

[MIT](LICENSE)
