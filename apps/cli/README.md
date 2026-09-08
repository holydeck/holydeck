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
| `auth` | Log in to, inspect, or log out from an OIDC-protected server |
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

## Book names

A book can be named by its USFM code or by its name in English, German or Tamil —
anywhere a book is accepted: sermon files, `get`, `revisions` and `offsets`.
Case, spacing and punctuation do not matter, and a leading ordinal may be written
any way you like:

```sh
holydeck get "GEN 30:5-7,9"
holydeck get "1. Mose 30:5-7,9"
holydeck get "2nd Samuel 1:6"     # or "2 Samuel", "II Samuel", "2. Samuel"
holydeck get "சங்கீதம் 118:24"
```

## Passages that are not synced yet

`get` and `get-verses` do not stop at a chapter the datastore lacks: they fetch it,
store it, and render from the stored copy, so an ad-hoc reference works without syncing
a whole translation first. A run that had to fetch says so on stderr in one line; add
`--verbose` and every chapter names its own source instead — `source: cache` with the
revision date, or `source: live · … · fetched just now` for one this run went and got.

```sh
holydeck get "GEN 30:5-7,9"                     # fetches GEN 30 if it is not stored yet
holydeck get "GEN 30:5-7,9" --verbose           # names the source of every chapter
holydeck get "GEN 30:5-7,9" --no-fetch-missing  # fails instead, leaving the datastore alone
```

Book names come from the translation's own canon, which the datastore learns on the first run
that may fetch — so citations read in the translation's language (`3. Mose`, `லேவியராகமம்`)
rather than in English. A store written before that, or imported without a canon, repairs
itself the same way; a run that cannot reach bible.com says so once and renders with English
names rather than failing.

Use `--no-fetch-missing` when a run must not reach the network, or to check what the
datastore really holds.

The server behaves the same way: `GET /api/v1/translations/:abbr/verses` and
`POST /api/v1/render` fetch a missing chapter unless the request passes
`?fetchMissing=false`. In server mode (`--server-url`) the CLI forwards the flag, so the
same command gives the same result wherever the data lives.

## Interrupting a sync

A whole translation is more than a thousand chapters, so `sync` is built to be stopped
and picked up again. Press Ctrl-C once: the run finishes the chapters already in
flight, saves them, releases the datastore lock and prints how far it got. Run the same
command again to continue with what is still missing. A second Ctrl-C quits at once,
which drops up to the last ten fetched chapters.

Each translation is locked while it is being written, so a second `sync` of the same
one waits for the first to finish rather than writing over it, and says which process
it is waiting for. A run that is killed outright leaves its lock behind; the next run
sees that the owning process is gone and takes the lock over, so there is nothing to
clean up by hand.

Steps with nothing to print — starting the browser, fetching the canon, waiting for a
lock — show a spinner on a terminal, so a slow command never looks like a hung one.
Progress and status go to stderr, leaving piped output clean.

## Server mode

Every command works against the local datastore by default. Pass
`--server-url <url>` (or set it in the config file) to use a self-hosted
HolyDeck server instead — the server ships as a container image at
`ghcr.io/holydeck/server`.

If the server is protected by an OpenID Connect provider, log in once before
using it:

```sh
holydeck --server-url https://bible.example.com auth login \
  --issuer https://auth.example.com \
  --client-id holydeck-cli \
  --resource https://bible.example.com
```

HolyDeck opens the provider's login page and listens for the authorization
callback on `127.0.0.1:53682`. The provider must allow that loopback redirect
URI, authorization-code flow, and PKCE `S256`. The default scopes are
`openid offline_access`. HolyDeck uses pushed authorization requests (PAR) when
the provider advertises them and otherwise uses a regular authorization request.

For a server protected by Authelia's bearer-token authorization, request its
special scope and the server URL as a resource prefix:

```sh
holydeck --server-url https://bible.example.com auth login \
  --issuer https://auth.example.com \
  --client-id holydeck-cli \
  --resource https://bible.example.com \
  --scope "offline_access authelia.bearer.authz"
```

That Authelia client must enforce PAR, PKCE `S256`, explicit consent and
`form_post`, and allow the server URL in its audience list. `--audience` remains
available for providers that need an exact audience request, but Authelia's
`resource` grant is what authorizes every API path below the server URL.

The login is stored per server in the platform config directory with permissions
limited to the current user. HolyDeck refreshes expired access tokens and retries
one request after a `401`. Use `holydeck auth status` to inspect the login without
printing tokens, or `holydeck auth logout` to remove it.

For unattended configuration, the required login options can also be supplied as
`HOLYDECK_OIDC_ISSUER` and `HOLYDECK_OIDC_CLIENT_ID`; optional values are
`HOLYDECK_OIDC_AUDIENCE`, `HOLYDECK_OIDC_RESOURCE`, and
`HOLYDECK_OIDC_SCOPE`, plus `HOLYDECK_OIDC_CALLBACK_PORT` when the default
port is unavailable. To make later logins just `holydeck auth login`, save
the same values as `serverUrl`, `oidcIssuer`, `oidcClientId`, `oidcAudience`,
`oidcResource`, `oidcScope`, and `oidcCallbackPort` in `config.yaml`. Run
`holydeck config init` to generate a commented template containing every key.

## Links

- Website: [holydeck.faith](https://holydeck.faith)
- Source and issues: [github.com/holydeck/holydeck](https://github.com/holydeck/holydeck)

## License

[MIT](https://github.com/holydeck/holydeck/blob/main/LICENSE)
