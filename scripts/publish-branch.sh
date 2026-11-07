#!/usr/bin/env bash
# Force-pushes a directory as the only commit of an orphan branch. CI uses this to publish its
# logs and public addresses (never keys) to the ci-build and ci-runner branches.
# Needs GITHUB_TOKEN and GITHUB_REPOSITORY, which GitHub Actions provides.
set -euo pipefail
branch="$1"
dir="$2"
tmp="$(mktemp -d)"
cp -r "$dir"/. "$tmp"/
cd "$tmp"
git init -q -b "$branch"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add -A
git commit -qm "$branch at ${GITHUB_SHA:-local} ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
git push -qf "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" "HEAD:refs/heads/$branch"
rm -rf "$tmp"
