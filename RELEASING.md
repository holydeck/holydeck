# Releasing HolyDeck

Every release is a **lockstep release train**: `@holydeck/core`, the `holydeck`
CLI, and `@holydeck/server` always share one version number. One release
produces:

| Artifact | Where |
| --- | --- |
| `holydeck@<version>` (CLI) | npmjs (with provenance; **staged** until a maintainer approves it); mirrored to GitHub Packages as `@holydeck/cli` (GitHub Packages only hosts scoped names) |
| `ghcr.io/holydeck/server:<version>`, plus `:latest` when it is the newest release | GHCR (`@holydeck/server` is never published to a registry — it ships as this image only) |
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
   - **verify** re-runs the full pipeline, checks that the tagged commit is
     reachable from `main`, and checks the tag, every manifest, the CLI
     constant, and the changelog all agree — a stray tag publishes nothing.
   - **publish-npm** waits for approval on the `release` environment
     (approve it under the repository's Actions run). It then *stages* the
     CLI on npmjs via OIDC trusted publishing — no npm token exists anywhere
     in CI. A staged version is uploaded but not installable; step 4 makes it
     live.
   - **mirror-github-packages** and **docker** run next: the GitHub Packages
     mirror and the `ghcr.io/holydeck/server` image push. The image gets the
     `:latest` tag only when this release is the newest `v*` tag, so
     re-running an old release's job cannot point `:latest` backwards.
   - **github-release** creates the GitHub Release with the changelog notes.

   These jobs do not wait for the npmjs approval, so GHCR and the GitHub
   Release go live while the npmjs version is still staged.

4. Approve the staged npm version — one approval, the CLI. Either run
   `npm stage list holydeck` and then `npm stage approve <stage-id>` (needs
   npm >= 11.15.0 locally), or open the **Staged Packages** tab on npmjs.com
   and click **Approve**. Both prompt for 2FA; that prompt is the whole point
   of staging, so it cannot be done from CI. Until you approve,
   `npm install holydeck` still serves the previous version.
   `npm stage reject <stage-id>` discards a staged version instead — use it
   if the release turns out to be bad before it goes live.

## When something fails

- **verify fails:** the tag was cut from an inconsistent state, or points at
  a commit that is not on `main`. Fix `main`, delete the tag locally and
  remotely, and release again.
- **Any job fails:** fix the cause and re-run the failed job from the
  workflow run page. Both publish steps ask the registry for the version
  first and `github-release` asks for the release, so in the normal case a
  re-run skips whatever an earlier run finished rather than failing on it.
  (`docker` has no such check — it simply pushes the same digest again, which
  is harmless.)
- **What the npmjs guard actually does:** it can see a *live* version but
  not a *staged* one — a trusted-publisher token may only run `npm publish`
  and `npm stage publish`, never `npm stage list`. So it skips outright when
  the version is already live, and otherwise stages, letting the job pass
  only if npm refuses with a duplicate-version error. Any other failure —
  an unauthorized action, a bad tarball, a registry write conflict, a
  network error — still fails the job, deliberately: the guard is narrow so
  that it can never report success with nothing staged. If a re-run of
  `publish-npm` does fail on a publish conflict, run `npm stage list holydeck`
  locally to see whether the version is already staged before doing anything
  else.
- **Manual publish fallback** (if a re-run is impossible): from a checkout
  of the release tag, build first (`pnpm turbo build --filter=holydeck...` —
  the CLI ships `dist/`, which is gitignored and only exists after a
  build), then run `pnpm pack` in `apps/cli` and `npm publish <tarball>` to
  the affected registry. For the GitHub Packages mirror, run
  `npm pkg set name=@holydeck/cli` in `apps/cli` first, before packing, and
  leave it uncommitted — that registry only hosts scoped names. Or skip
  manual recovery and roll forward with the next patch release instead.
- **A version shipped broken:** versions on npmjs are immutable. Ship the
  fix as the next patch release; use `npm deprecate` on the broken version
  if users must be warned.

## One-time setup (maintainer)

Automated releases need one-time configuration that only a human can do:

- npmjs: the `holydeck` package must exist (publish a placeholder manually
  once — staging cannot create a brand-new package), then configure a
  **trusted publisher** for it (GitHub Actions; repository
  `holydeck/holydeck`, workflow `release.yml`, environment `release`).
- npmjs, **after** the first staged release has gone through end to end:
  edit that trusted publisher's allowed actions and uncheck "can also
  publish directly", leaving `npm stage publish` as the only thing CI can
  do. Waiting keeps a direct publish available as an escape hatch while
  staging is still unproven; skipping it altogether leaves CI able to put a
  version live without an approval.
- GitHub: create the `release` environment with a required reviewer and
  restrict it to `v*` tags; add "Repository admin" to the `main` ruleset's
  bypass list so the release commit + tag push is accepted.
- GitHub: add a ruleset for tags matching `v*` that restricts creation and
  deletion to repository admins, so only a maintainer can start a release
  train.
- GHCR: after the first image push, set the `server` package's visibility to
  public.
