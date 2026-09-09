# Releasing HolyDeck

Every release is a **lockstep release train**: `@holydeck/core`, the `@holydeck/cli`
CLI, and `@holydeck/server` always share one version number. One release
produces:

| Artifact | Where |
| --- | --- |
| `@holydeck/cli@<version>` | npmjs (with provenance) and GitHub Packages |
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
   - **publish-npm** publishes the CLI directly to npmjs via OIDC trusted
     publishing — no npm token exists anywhere in CI. npm scans the upload
     before making it available.
   - **mirror-github-packages** and **docker** run next: the GitHub Packages
     mirror and the `ghcr.io/holydeck/server` image push. The image gets the
     `:latest` tag only when this release is the newest `v*` tag, so
     re-running an old release's job cannot point `:latest` backwards.
   - **github-release** creates the GitHub Release with the changelog notes.

   GitHub Packages, GHCR and the GitHub Release continue after npm accepts the
   upload; npmjs visibility may follow shortly after its registry scan.

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
- **What the npmjs guard actually does:** it skips a version that is already
  live. A newly uploaded version may remain invisible while npm scans it, so
  the guard also accepts npm's narrow duplicate-version response on a re-run.
  Any other failure — an unauthorized action, a bad tarball, a registry write
  conflict, or a network error — still fails the job deliberately.
- **Manual publish fallback** (if a re-run is impossible): from a checkout
  of the release tag, build first (`pnpm turbo build --filter=@holydeck/cli...` —
  the CLI ships `dist/`, which is gitignored and only exists after a
  build), then run `pnpm pack` in `apps/cli` and `npm publish <tarball>` to
  the affected registry. Or skip manual recovery and roll forward with the
  next patch release instead.
- **A version shipped broken:** versions on npmjs are immutable. Ship the
  fix as the next patch release; use `npm deprecate` on the broken version
  if users must be warned.

## One-time setup (maintainer)

Automated releases need one-time configuration that only a human can do:

- npmjs: the `@holydeck/cli` package must exist (publish it manually once),
  then configure a
  **trusted publisher** for it (GitHub Actions; repository
  `holydeck/holydeck`, workflow `release.yml`, environment `release`) and
  enable its **can also publish directly** option.
- GitHub: create the `release` environment without a required reviewer and
  restrict it to `v*` tags; add "Repository admin" to the `main` ruleset's
  bypass list so the release commit + tag push is accepted.
- GitHub: add a ruleset for tags matching `v*` that restricts creation and
  deletion to repository admins, so only a maintainer can start a release
  train.
- GHCR: after the first image push, set the `server` package's visibility to
  public.

## Migrating from the unscoped CLI package

The scoped package replaces the former `holydeck` package on npmjs. Perform
these steps once, before cutting the first release from the scoped manifest:

1. Ensure the `holydeck` organization exists on npmjs and your account can
   publish public packages in its scope.
2. From the migration branch, publish the current CLI once so the scoped
   package and its settings exist:

   ```sh
   pnpm turbo build --filter=@holydeck/cli...
   pack_dir="$(mktemp -d)"
   pnpm --dir apps/cli pack --pack-destination "$pack_dir"
   npm publish "$pack_dir/holydeck-cli-2026.9.2.tgz" --access public
   npm view @holydeck/cli version
   ```

3. Configure its trusted publisher for direct publishing as described above,
   then merge the migration branch.
4. Immediately after merging, stop publishing `holydeck` and deprecate all
   existing versions with:

   ```sh
   npm deprecate "holydeck@*" "Moved to @holydeck/cli; install with npm install -g @holydeck/cli"
   ```

5. Cut the next normal release, then verify
   `npm view @holydeck/cli version` returns that version.

Existing installations keep working at their last published version, while
new installs receive the migration warning.
