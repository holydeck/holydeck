#!/usr/bin/env bash
set -uo pipefail

# Resyncs gitignored config/secrets (scripts/sync-worktree-config.sh) into
# every worktree of this repo except the primary one. Meant to be run by a
# launchd agent watching .git/worktrees for changes, but safe to run by hand
# too. Intentionally does not use `set -e`: one worktree failing to sync
# (e.g. still mid-checkout) must not stop the rest.
#
# Generic engine shared across projects, symlinked in as
# <project>/scripts/sync-all-worktrees.sh.
#
# Usage: scripts/sync-all-worktrees.sh [--force]
#
#   --force   forwarded to sync-worktree-config.sh for every worktree:
#             replace real files too (backed up first), instead of only
#             filling in what's missing. Only meant for a manual run --
#             the launchd watcher never passes this.

force_flag=""
if [[ "${1:-}" == "--force" ]]; then
  force_flag="--force"
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

project="$(basename "$repo_root")"
primary_root="$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')"

git worktree list --porcelain | awk '/^worktree /{print $2}' | while read -r path; do
  [[ "$path" == "$primary_root" ]] && continue

  # Ephemeral, tool-created worktrees nested inside a hidden tooling
  # directory (<repo>/.<tool>/worktrees/<name>) are scratch task workspaces
  # and shouldn't get production secrets auto-linked into them. Note: a bare
  # .worktrees/ at the repo root is a different, project-chosen convention
  # for regular long-lived feature worktrees in some repos -- it has no
  # hidden parent directory, so it does not match and is not skipped.
  [[ "$path" == */.*/worktrees/* ]] && continue

  ready=0
  for _ in $(seq 1 10); do
    if [[ -d "$path" && -n "$(ls -A "$path" 2>/dev/null | grep -v '^\.git$')" ]]; then
      ready=1
      break
    fi
    sleep 1
  done
  if [[ "$ready" -eq 0 ]]; then
    echo "$(date '+%F %T') [$project] skip (not checked out yet): $path"
    echo
    continue
  fi

  echo "$(date '+%F %T') [$project] syncing $path"
  if [[ -n "$force_flag" ]]; then
    "$repo_root/scripts/sync-worktree-config.sh" "$path" "$force_flag"
  else
    "$repo_root/scripts/sync-worktree-config.sh" "$path"
  fi
done
