# Releasing HolyDeck

Every release is a **lockstep release train**: `@holydeck/core`, the `holydeck`
CLI, and `@holydeck/server` always share one version number. One release
produces:

| Artifact | Where |
| --- | --- |
| `holydeck@<version>` (CLI) | npmjs (with provenance); mirrored to GitHub Packages as `@holydeck/cli` (GitHub Packages only hosts scoped names) |
| `ghcr.io/holydeck/server:<version>` and `:latest` | GHCR (`@holydeck/server` is never published to a registry — it ships as this image only) |
| GitHub Release `v<version>` | notes taken from the `CHANGELOG.md` section |

`@holydeck/core` is deliberately **not published** to any registry: it is a
private workspace library (`"private": true`), bundled into the CLI at build
time and compiled into the server image. It still gets the lockstep version
bump so the workspace stays consistent. Should an external consumer ever need
it, publishing can be re-enabled by dropping the `private` flag and restoring
a publish step — until then there is nothing to maintain on npm for it.

## Version scheme

Calver `yyyy.m.patch` (UTC year, unpadded UTC month, patch = release counter
within the month starting at 0). Example: the first September 2026 release is
`2026.9.0`, the next one `2026.9.1`, the first October release `2026.10.0`.
Every value is valid semver, so tooling needs no special handling.

To switch the project to commit-driven semver: in `.release-it.json`, delete
the `./scripts/release/calver-plugin.mjs` plugin entry and set the
`@release-it/conventional-changelog` plugin's `ignoreRecommendedBump` to
`false`. Nothing else changes.

## Cutting a release

Prerequisites: you are a repository admin (the release push bypasses branch
protection via the ruleset's admin bypass), commit signing works on your
machine, and you are on a clean, up-to-date `main`.

1. Optional but recommended — rehearse:

   ```sh
   pnpm exec release-it --dry-run
   ```

   Shows the computed version, the changelog section, and the git actions
   without executing anything.

2. Release:

   ```sh
   pnpm release
   ```

   release-it then:
   - runs the release script tests and the full turbo pipeline (a red
     pipeline aborts the release before anything is written),
   - computes the next calver version,
   - prepends the new section to `CHANGELOG.md`,
   - bumps the version in the root, `packages/core`, `apps/cli`
     (including the embedded `CLI_VERSION` constant), and `apps/server`,
   - creates ONE signed commit `chore(release): v<version>`, tags it
     `v<version>`, and pushes commit + tag.

3. The tag triggers the `release` workflow:
   - **verify** re-runs the full pipeline and checks the tag, every
     manifest, the CLI constant, and the changelog all agree — a stray tag
     publishes nothing.
   - **publish-npm** waits for approval on the `release` environment
     (approve it under the repository's Actions run). It then publishes the
     CLI to npmjs via OIDC trusted publishing — no npm token exists
     anywhere in CI.
   - **mirror-github-packages** and **docker** run next: the GitHub Packages
     mirror and the `ghcr.io/holydeck/server` image push.
   - **github-release** creates the GitHub Release with the changelog notes.

## When something fails

- **verify fails:** the tag was cut from an inconsistent state. Fix `main`,
  delete the tag locally and remotely, and release again.
- **A publish job fails:** `publish-npm` and `mirror-github-packages` each
  publish exactly one artifact (the CLI), and the `npm publish` is the
  job's last step — so a red job means that registry received nothing. Fix
  the cause and re-run the failed job from the workflow run page. (npm
  refuses to publish over an already-published version, so a re-run of a
  job whose publish actually went through dies with a "cannot publish over"
  error — that error just means there is nothing left to publish there.)
- **Manual publish fallback** (if a re-run is impossible): from a checkout
  of the release tag, build first (`pnpm turbo build --filter=holydeck...` —
  the CLI ships `dist/`, which is gitignored and only exists after a
  build), then `pnpm pack` in `apps/cli` and `npm publish <tarball>` to the
  affected registry. Mirroring to GitHub Packages also needs
  `npm pkg set name=@holydeck/cli` run in `apps/cli` first, uncommitted,
  since that registry only hosts scoped names. Or skip manual recovery and
  roll forward with the next patch release instead.
- **A version shipped broken:** versions on npmjs are immutable. Ship the
  fix as the next patch release; use `npm deprecate` on the broken version
  if users must be warned.

## One-time setup (maintainer)

Automated releases need one-time configuration that only a human can do:

- npmjs: the `holydeck` package must exist (publish a placeholder manually
  once), then configure a **trusted publisher** for it (GitHub Actions;
  repository `holydeck/holydeck`, workflow `release.yml`, environment
  `release`).
- GitHub: create the `release` environment with a required reviewer and
  restrict it to `v*` tags; add "Repository admin" to the `main` ruleset's
  bypass list so the release commit + tag push is accepted.
- GHCR: after the first image push, set the `server` package's visibility to
  public.
