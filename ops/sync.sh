#!/usr/bin/env bash
# Pull, resolving conflicts in derived collector output by preferring the remote
# (CI runs more recently than a workstation) and then regenerating locally.
#
# data/escapes/ and data/saas.json are AUTHORED and must never be resolved this
# way — a conflict there is a real one that needs reading.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! git pull --rebase origin main; then
  conflicts=$(git diff --name-only --diff-filter=U)
  authored=$(echo "$conflicts" | grep -E 'data/(escapes/|saas\.json|storage\.json)' || true)
  if [ -n "$authored" ]; then
    echo "Conflict in authored data — resolve by hand:" >&2
    echo "$authored" >&2
    exit 1
  fi
  echo "$conflicts" | grep -E '^data/sources/' | while read -r f; do
    [ -n "$f" ] && git checkout --theirs "$f" && git add "$f"
  done
  GIT_EDITOR=true git rebase --continue
fi

node pipeline/render/build.js
