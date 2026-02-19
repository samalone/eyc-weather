#!/bin/bash
# Build and push multi-platform Docker image for EYC Weather production.
#
# Builds for both AMD64 (Linode) and ARM64 (local dev) platforms,
# tags with the version from k8s/prod/kustomization.yaml, and pushes
# to Docker Hub.
#
# Prerequisites:
#   - Docker buildx configured with multi-platform support
#   - Logged in to Docker Hub (docker login)
#   - yq installed (brew install yq)
#
# Usage:
#   ./scripts/build-production-image.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
KUSTOMIZATION_FILE="$PROJECT_ROOT/k8s/prod/kustomization.yaml"

# Check if yq is available
if ! command -v yq &> /dev/null; then
    echo "Error: yq is not installed"
    echo "Install: brew install yq"
    exit 1
fi

# Extract version from kustomization.yaml
VERSION=$(yq eval '.images[0].newTag' "$KUSTOMIZATION_FILE")

if [ -z "$VERSION" ] || [ "$VERSION" = "null" ]; then
    echo "Error: Could not read version from $KUSTOMIZATION_FILE"
    exit 1
fi

IMAGE_NAME="llamagraphics/eyc-weather"

echo "Building multi-platform Docker image for EYC Weather v${VERSION}..."
echo ""

# Ensure buildx is available
if ! docker buildx version &> /dev/null; then
    echo "Error: docker buildx is not available"
    exit 1
fi

# Use existing multi-arch builder if available
if ! docker buildx inspect multiplatform &> /dev/null 2>&1; then
    echo "Creating buildx builder 'multiplatform'..."
    docker buildx create --name multiplatform --use
else
    docker buildx use multiplatform
fi

# Build and push for both platforms
echo "Building for linux/amd64 and linux/arm64..."
docker buildx build \
    --platform linux/amd64,linux/arm64 \
    --tag "${IMAGE_NAME}:${VERSION}" \
    --tag "${IMAGE_NAME}:latest" \
    --push \
    "$PROJECT_ROOT"

echo ""
echo "Successfully built and pushed:"
echo "   ${IMAGE_NAME}:${VERSION}"
echo "   ${IMAGE_NAME}:latest"
