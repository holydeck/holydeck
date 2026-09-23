# Worktree config sync

Config and secret files that are gitignored (`.env*`, service-account JSON, signing
keys, ...) live only in the primary worktree by default -- creating a new worktree
with `git worktree add` does not bring them along. These scripts fix that by
symlinking the listed files from the primary worktree into any other worktree.

## Files

- `worktree-sync-files.txt` -- the list of repo-relative paths to sync, one per
  line. Blank lines and `#`-comments are ignored. Edit this file to add or remove
  what gets synced.
- `sync-worktree-config.sh <target-worktree-path> [--force]` -- syncs the manifest
  into a single target worktree.
- `sync-all-worktrees.sh [--force]` -- runs the above for every worktree of this
  repo except the primary one.

## Usage

```bash
# after creating a new worktree
scripts/sync-worktree-config.sh ../my-new-worktree

# or resync everything at once
scripts/sync-all-worktrees.sh
```

By default, a file that already exists as a real (non-symlink) file in the target
worktree is left alone and reported as skipped. Pass `--force` to replace it with a
symlink instead -- the original is backed up first, next to it, as
`<name>.bak.<timestamp>`.

On this machine, `sync-all-worktrees.sh` also runs automatically via a background
watcher whenever a worktree is added or removed, so it usually doesn't need to be
run by hand. Ephemeral, tool-created scratch worktrees are detected and skipped
automatically -- they never receive synced secrets.

Note: this repo also keeps long-lived feature worktrees under `.worktrees/`. Those
are regular worktrees, not scratch space, so they're synced like any other.
