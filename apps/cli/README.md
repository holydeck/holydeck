# holydeck

Bible verses for sermons and presentations, from a local revisioned datastore.

`holydeck` turns a dated sermon file (the verses for a service) into clean,
ready-to-paste slide text for any number of translations. Verses live in a
local datastore on your machine, so Sunday never depends on the internet
being up.

## Requirements

- Node.js 24 or newer

## Install

```sh
npm install -g holydeck
# or run it without installing
npx holydeck --help
```

## Quick start

```sh
# write a commented starter config (default translations, data directory, …)
holydeck config init

# download the translations you use into the local datastore
holydeck sync KJV WEB

# render a single reference ad hoc
holydeck get "PSA 118:24"

# scaffold a dated sermon file, check it, render it
holydeck new
holydeck preflight --last
holydeck get-verses --last
```

## Commands

| Command | What it does |
| --- | --- |
| `new` | Scaffold a dated sermon file and open it in `$EDITOR` |
| `preflight` | Verify every passage of a sermon file is available, fetching what is missing |
| `get-verses` | Render a sermon file to text output |
| `get` | Render a single reference ad hoc, e.g. `holydeck get "PSA 118:24"` |
| `sync` | Download or update whole translations in the local datastore |
| `translations` | List known translations (local) or the translations a server offers |
| `stats` | Show what the local datastore holds: coverage, revisions, size on disk |
| `revisions` | List or diff the stored revisions of a chapter |
| `offsets` | Compare verse counts between two stored translations to find versification offsets |
| `import` | Merge an exported translation store file into the local datastore |
| `config` | Manage the HolyDeck config file |
| `info` | Show the effective configuration and where each value came from |
| `doctor` | Check config, datastore, network, and server health |
| `completion` | Print a shell completion script (zsh or bash) |

Run `holydeck <command> --help` for the full options of any command.

## Server mode

Every command works against the local datastore by default. Pass
`--server-url <url>` (or set it in the config file) to use a self-hosted
HolyDeck server instead — the server ships as a container image at
`ghcr.io/holydeck/server`.

## Links

- Website: [holydeck.faith](https://holydeck.faith)
- Source and issues: [github.com/holydeck/holydeck](https://github.com/holydeck/holydeck)

## License

[MIT](https://github.com/holydeck/holydeck/blob/main/LICENSE)
