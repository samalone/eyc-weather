#!/bin/bash
# Release a new version of EYC Weather
#
# This script:
# 1. Bumps the version in k8s/prod/kustomization.yaml
# 2. Builds and pushes the production Docker image
# 3. Deploys to production Kubernetes
# 4. Commits the version change
# 5. Creates an annotated git tag
# 6. Pushes commit and tag to GitHub
#
# Usage: scripts/release.sh [major|minor|patch]
#
# If the Docker build fails, the version number is automatically
# reverted to its original value.
#
# Prerequisites: yq, semver, docker, kubectl

set -euo pipefail

KUSTOMIZATION="k8s/prod/kustomization.yaml"
BUMP_TYPE="${1:-}"

# Validate arguments
if [[ -z "$BUMP_TYPE" ]]; then
    echo "Error: Version component required" >&2
    echo "Usage: $0 [major|minor|patch]" >&2
    exit 1
fi

if [[ ! "$BUMP_TYPE" =~ ^(major|minor|patch)$ ]]; then
    echo "Error: Invalid version component: $BUMP_TYPE" >&2
    echo "Usage: $0 [major|minor|patch]" >&2
    exit 1
fi

cd "$(dirname "$0")/.."

# Read the current version before bumping
ORIGINAL_VERSION=$(yq '.images[] | select(.name == "llamagraphics/eyc-weather") | .newTag' "$KUSTOMIZATION")

if [[ -z "$ORIGINAL_VERSION" ]]; then
    echo "Error: Could not read current version from $KUSTOMIZATION" >&2
    exit 1
fi

echo "==> Current version: $ORIGINAL_VERSION"

# Function to revert version on error
revert_version() {
    local exit_code=$?
    if [[ $exit_code -ne 0 ]]; then
        echo "" >&2
        echo "==> ERROR: Build or deployment failed! Reverting version..." >&2
        yq -i "(.images[] | select(.name == \"llamagraphics/eyc-weather\") | .newTag) = \"$ORIGINAL_VERSION\"" "$KUSTOMIZATION"
        echo "==> Version reverted to $ORIGINAL_VERSION" >&2
        exit $exit_code
    fi
}

# Set up trap to revert on error
trap revert_version EXIT

echo "==> Bumping $BUMP_TYPE version..."
./scripts/bump.sh "$BUMP_TYPE"

# Read the new version
VERSION=$(yq '.images[] | select(.name == "llamagraphics/eyc-weather") | .newTag' "$KUSTOMIZATION")

if [[ -z "$VERSION" ]]; then
    echo "Error: Could not read new version from kustomization.yaml" >&2
    exit 1
fi

echo "==> New version: $VERSION"

echo "==> Building production image..."
./scripts/build-production-image.sh

echo "==> Deploying to production..."
kubectl --context pc apply -k k8s/prod

# Image is pushed and manifests applied — version is locked, don't revert
trap - EXIT

kubectl --context pc rollout restart deployment/eyc-weather
kubectl --context pc rollout status deployment/eyc-weather

echo "==> Committing version change..."
git add "$KUSTOMIZATION" package.json package-lock.json
git commit -m "Version $VERSION"

echo "==> Creating annotated tag $VERSION..."
git tag -a "$VERSION" -m "Release $VERSION"

echo "==> Pushing to GitHub..."
git push origin main
git push origin "$VERSION"

echo ""
echo "Release $VERSION complete!"
echo "  - Image: llamagraphics/eyc-weather:$VERSION"
echo "  - Deployed to: production (Linode Kubernetes)"
echo "  - Tag: $VERSION"
