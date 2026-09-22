# Releasing HolyDeck

Every release is a **lockstep release train**: `@holydeck/core`, the `@holydeck/cli`
CLI, and `@holydeck/corpus` always share one version number. One release
produces:

| Artifact | Where |
| --- | --- |
| `@holydeck/cli@<version>` | npmjs (with provenance) and GitHub Packages |
| `ghcr.io/holydeck/corpus:<version>`, plus `:latest` when it is the newest stable release | GHCR (`@holydeck/corpus` is never published to a registry — it ships as this image only); for one deprecation window, until the first stable release after v1.0, the same digest is also pushed as the deprecated `ghcr.io/holydeck/server:<version>` alias, plus `:latest` for stable releases |
| `ghcr.io/holydeck/app:<version>`, plus `:latest` when it is the newest stable release | GHCR |
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
     (including the embedded `CLI_VERSION` constant), and `apps/corpus`,
   - creates ONE signed commit `chore(release): v<version>`, tags it
     `v<version>`, and pushes commit + tag.

3. The tag triggers the `release` workflow:
   - **verify** re-runs the full pipeline, checks that the tagged commit is
     reachable from `main`, and checks the tag, every manifest, the CLI
     constant, and the changelog all agree — a stray tag publishes nothing.
     It also fails closed if any T11 legal decision is not recorded and
     accepted (`scripts/release/legal-gate.mjs`), or if the repository split
     has slipped (an AI-tooling planning artifact, or an AI coding assistant
     credited as author, checked into this tree —
     `scripts/verify/docs-split.mjs`).
   - **publish-npm** publishes the CLI directly to npmjs via OIDC trusted
     publishing — no npm token exists anywhere in CI. npm scans the upload
     before making it available, and attaches provenance automatically.
   - **mirror-github-packages** and **docker** run next: the GitHub Packages
     mirror and the `ghcr.io/holydeck/corpus` and `ghcr.io/holydeck/app` image
     pushes. The images get the `:latest` tag only when this release is the
     newest stable release, so
     re-running an old release's job cannot point `:latest` backwards. Once
     pushed, the images are signed keylessly with cosign; a signing failure
     fails the job and no later job runs. See "Verifying a release" below.
   - **github-release** creates the GitHub Release with the changelog notes.

   GitHub Packages, GHCR and the GitHub Release continue after npm accepts the
   upload; npmjs visibility may follow shortly after its registry scan.

## Releasing to `next`

Run `pnpm release:next` to cut a prerelease with `release-it --preRelease=next`. It produces a
version shaped `yyyy.m.patch-next.N` instead of the stable `yyyy.m.patch`, and may be run from
either `main` or `next`, the two branches allowed by `git.requireBranch`.

The CLI publishes under the npm `next` dist-tag, so `npm install @holydeck/cli@next` tries the
prerelease while a plain `npm install @holydeck/cli` never selects one. Each image gets its exact
version tag and the moving `:next` tag for the newest prerelease build, but never `:latest`.

The legal gate in `scripts/release/legal-gate.mjs` applies the same full checks to `next` as to
`stable` under the current `NEXT_CHANNEL_POLICY = 'full'`. A second, currently disabled policy
exists there for a possible future prerelease exemption.

## Verifying a release

The published CLI and container images can be verified independently of this repository,
with no access to CI or its logs.

**A container image** is signed keylessly (Sigstore/cosign, via the
`docker` job's GitHub Actions OIDC identity — no private key exists anywhere
for this to leak). Verify a tag's signature with:

```sh
cosign verify \
  --certificate-identity-regexp '^https://github\.com/holydeck/holydeck/\.github/workflows/docker-build\.yml@refs/tags/.*$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/holydeck/corpus:<version>
```

A successful verification prints the signing certificate and its Rekor
transparency-log entry. `cosign verify` resolves the tag to the digest it
points at, so this also confirms the tag has not been moved to point at an
unsigned image since release.

**The CLI package** carries npm provenance from `publish-npm`'s OIDC
publish. Check it with either:

```sh
npm view @holydeck/cli@<version> dist.attestations --registry https://registry.npmjs.org
```

or the "Provenance" badge on the package's npmjs.com page, which links the
published tarball back to this repository and the exact workflow run that
built it.

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
- GHCR: after the first image push, set the `corpus` and `app` packages' visibility to public.
- GitHub: add a ruleset for the `next` branch (required for `pnpm release:next`'s tag to have
  somewhere protected to be pushed from) requiring the same status checks as `main`'s:
  `verify`, `docker / images (corpus)`, `docker / images (app)` — the exact names `ci.yml`
  produces, `docker` from that workflow's own job id and `images (<name>)` from
  `docker-build.yml`'s pinned matrix job name. If either job is ever renamed again, or the
  matrix's `name` values change, update the ruleset's required checks to match before merging
  that change, or a stale required-check name blocks every future PR silently.

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
