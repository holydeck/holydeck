# holydeck

Bible verses for sermons and presentations, from a local revisioned datastore.

`holydeck` turns a dated sermon file (the verses for a service) into clean,
ready-to-paste slide text for any number of translations. Verses live in a
local datastore on your machine, so Sunday never depends on the internet
being up.

## Requirements

- Node.js 24 or newer
- A headless Chromium for downloading translations — installed automatically with the
  optional `puppeteer` dependency, see [Fetching from bible.com](#fetching-from-biblecom)

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

## Shell completion

```sh
# zsh
echo 'source <(holydeck completion zsh)' >> ~/.zshrc

# bash
echo 'source <(holydeck completion bash)' >> ~/.bashrc
```

Restart your shell to pick it up. Completions are fetched live from the
installed CLI, so they stay in sync automatically as commands are added —
nothing to regenerate or update. Commands, `--flags`, and Bible book codes
complete with a description alongside each candidate (zsh shows these
inline; bash just completes the value).

> **zsh:** `compinit` should only run once per shell, after this line runs.
> Some tools (Docker Desktop's completion snippet, for example) add a
> second `compinit` call later in `.zshrc`, which silently un-registers
> completions sourced above it — move those calls earlier if completion
> stops working.

If you're running via `npx` instead of a global install, wrap it in a
function first so `holydeck` resolves on your `$PATH`:

```sh
holydeck() { npx --yes holydeck@latest "$@"; }
source <(holydeck completion zsh)
```

(This adds `npx` startup latency to every completion trigger.)

## Fetching from bible.com

bible.com answers plain HTTP clients with a JavaScript challenge page, so `sync`,
`preflight` and an ad-hoc `get` of an unstored chapter need a real browser to run it.
Pass `--browser-fetch` (or set `browserFetch: true` in the config file, or
`HOLYDECK_BROWSER_FETCH=1`) and the fetch goes through a headless Chromium instead:

```sh
holydeck sync KJV --browser-fetch
```

The browser starts once per command and is reused for the whole run. Chromium comes
from the optional `puppeteer` dependency; if you only render from an already-populated
datastore you can skip the download with `npm install -g holydeck --omit=optional`.

`holydeck doctor` reports which transport it reached bible.com with, so run it first
when a sync stops returning content.

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
