#!/bin/bash
# Expand the K8s secret template into a deployable manifest.
#
# Reads k8s/prod/secret.template.yaml (checked into git, contains only
# `op://` references) and uses the 1Password CLI to resolve those references
# into k8s/prod/secret.yaml (gitignored, contains the real secret values).
#
# Run this before `kubectl apply -k k8s/prod` whenever the secret template
# changes or the underlying 1Password values rotate.
#
# Prerequisites: op (1Password CLI), signed in to the
# edgewoodyachtclub.1password.com account (`op signin`).

set -euo pipefail

cd "$(dirname "$0")/.."

ACCOUNT="edgewoodyachtclub.1password.com"
TEMPLATE="k8s/prod/secret.template.yaml"
OUTPUT="k8s/prod/secret.yaml"

if ! command -v op >/dev/null 2>&1; then
    echo "Error: 1Password CLI (op) is not installed." >&2
    echo "Install it from https://developer.1password.com/docs/cli/get-started/" >&2
    exit 1
fi

if [[ ! -f "$TEMPLATE" ]]; then
    echo "Error: template not found: $TEMPLATE" >&2
    exit 1
fi

echo "==> Injecting secrets from 1Password ($ACCOUNT)..."
# Write with restrictive permissions, since the output contains live secrets.
umask 077
op inject --account "$ACCOUNT" -i "$TEMPLATE" -o "$OUTPUT" --force

echo "==> Wrote $OUTPUT (gitignored)."
echo "    Apply with: kubectl --context pc apply -k k8s/prod"
