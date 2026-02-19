#!/bin/bash
# Bump the production image version for eyc-weather.
#
# Reads the current version from k8s/prod/kustomization.yaml,
# bumps it using semver, and writes back the new version.
#
# Usage: scripts/bump.sh [major|minor|patch]  (default: patch)
#
# Prerequisites: yq (https://github.com/mikefarah/yq)
#                semver (npm install -g semver)

set -euo pipefail

KUSTOMIZATION="k8s/prod/kustomization.yaml"
BUMP_TYPE="${1:-patch}"

if [[ ! -f "$KUSTOMIZATION" ]]; then
    echo "Error: $KUSTOMIZATION not found. Run from the repository root." >&2
    exit 1
fi

CURRENT=$(yq '.images[] | select(.name == "llamagraphics/eyc-weather") | .newTag' "$KUSTOMIZATION")

if [[ -z "$CURRENT" ]]; then
    echo "Error: Could not read current version from $KUSTOMIZATION" >&2
    exit 1
fi

NEXT=$(semver -i "$BUMP_TYPE" "$CURRENT")

yq -i "(.images[] | select(.name == \"llamagraphics/eyc-weather\") | .newTag) = \"$NEXT\"" "$KUSTOMIZATION"

# Keep package.json version in sync (displayed in the UI footer)
npm --no-git-tag-version version "$NEXT" > /dev/null

echo "Bumped llamagraphics/eyc-weather: $CURRENT -> $NEXT"
