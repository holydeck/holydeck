# HolyDeck

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

## License

[MIT](LICENSE)
