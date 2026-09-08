# HolyDeck

[![CI](https://github.com/holydeck/holydeck/actions/workflows/ci.yml/badge.svg)](https://github.com/holydeck/holydeck/actions/workflows/ci.yml)
[![Release](https://github.com/holydeck/holydeck/actions/workflows/release.yml/badge.svg)](https://github.com/holydeck/holydeck/actions/workflows/release.yml)
[![npm version](https://img.shields.io/npm/v/holydeck)](https://www.npmjs.com/package/holydeck)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A full setup for Sunday — bible verses and song slides, from sermon prep to screen.

> **Status: early development.** The first release has shipped: the CLI is on npm as
> [`holydeck`](https://www.npmjs.com/package/holydeck) and the server is available as
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

CI runs a single Node 24 lane: `engines` demands Node >= 24 everywhere, the CLI bundles its
dependencies, and the server ships as a container pinned to its own Node version, so a version
matrix would only re-test the same floor. Revisit this once Node 26 (the next LTS) enters the
support window.

## License

[MIT](LICENSE)
