#!/usr/bin/env bash
set -euo pipefail

# Symlinks gitignored config/secret files (.env*, service-account JSON,
# signing keys, ...) from the primary worktree into another worktree, so
# they don't need to be recreated by hand per worktree.
#
# Generic engine shared across projects, symlinked in as
# <project>/scripts/sync-worktree-config.sh. The list of paths to sync is
# read from <primary-worktree>/scripts/worktree-sync-files.txt (one
# repo-relative path per line; blank lines and #-comment lines ignored).
#
# Usage: scripts/sync-worktree-config.sh <target-worktree-path> [--force]
#
#   --force   replace real (non-symlink) files too, instead of skipping
#             them. The replaced file is backed up next to it first, as
#             <name>.bak.<timestamp> -- never silently discarded.

force=0
target=""
for arg in "$@"; do
  case "$arg" in
    --force) force=1 ;;
    *) target="$arg" ;;
  esac
done

if [[ -z "$target" ]]; then
  echo "usage: $(basename "$0") <target-worktree-path> [--force]" >&2
  exit 1
fi
target="$(cd "$target" && pwd)"

source_root="$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
project="$(basename "$source_root")"
manifest="$source_root/scripts/worktree-sync-files.txt"

if [[ "$source_root" == "$target" ]]; then
  echo "[$project] target is the primary worktree, nothing to sync" >&2
  exit 0
fi

if [[ ! -f "$manifest" ]]; then
  echo "[$project] no scripts/worktree-sync-files.txt manifest, nothing to sync" >&2
  exit 0
fi

echo "[$project] syncing into $target"

linked=0
skipped=0
replaced=0
missing=0

while IFS= read -r f || [[ -n "$f" ]]; do
  [[ -z "$f" || "$f" == \#* ]] && continue

  src="$source_root/$f"
  dest="$target/$f"

  if [[ ! -e "$src" ]]; then
    missing=$((missing + 1))
    continue
  fi

  if [[ -e "$dest" && ! -L "$dest" ]]; then
    if [[ "$force" -eq 0 ]]; then
      echo "[$project] skip (real file already present, use --force to replace): $f"
      skipped=$((skipped + 1))
      continue
    fi

    backup="$dest.bak.$(date +%Y%m%d%H%M%S)"
    mv "$dest" "$backup"
    echo "[$project] backed up to $(basename "$backup"), replacing with symlink: $f"
    replaced=$((replaced + 1))
  fi

  mkdir -p "$(dirname "$dest")"
  ln -sf "$src" "$dest"
  linked=$((linked + 1))
done < "$manifest"

echo "[$project] synced $linked file(s) into $target ($skipped skipped, $replaced replaced+backed up, $missing not found in source)"
echo
