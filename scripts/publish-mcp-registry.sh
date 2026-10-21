#!/usr/bin/env bash
# List commonly-mcp on the official MCP Registry (registry.modelcontextprotocol.io)
# from commonly-mcp/server.json. Run by npm-publish.yml after the npm package of
# the same version is live; MCP clients that read the registry (Magpie's
# Library among them) show the entry from there.
#
# Idempotent. If the registry already lists this name at this version it does
# nothing, so a re-run, or a push that publishes nothing, costs one GET. That is
# also why the workflow runs it whether or not this push published to npm: a
# publish that failed here can be retried by re-running the job.
#
# Auth: GitHub OIDC, no secret. The registry grants a workflow the namespace of
# the repository's owner, io.github.Team-Commonly/* (registry
# internal/api/handlers/v0/auth/github_oidc.go, buildPermissions), and needs
# the job's `id-token: write`.
#
# The registry verifies the npm package by its package.json `mcpName`, so the
# version must be on npm first; this checks that before publishing.
set -euo pipefail

REGISTRY=https://registry.modelcontextprotocol.io
# Pinned and checksummed rather than "latest": this binary runs with the job's
# id-token. Bump both together from the release's registry_<v>_checksums.txt.
PUBLISHER_VERSION=v1.8.1
PUBLISHER_SHA256=a06c9096dcb9727c13555b6be26c7effa707b01f06a4c561ba7a3635443cf2cc

cd "$(dirname "$0")/../commonly-mcp"

name=$(node -p "require('./server.json').name")
version=$(node -p "require('./server.json').version")
pkg=$(node -p "require('./package.json').name")
pkg_v=$(node -p "require('./package.json').version")
if [ "$version" != "$pkg_v" ]; then
  echo "::error::server.json says $version but package.json says $pkg_v; the suite should have caught this"
  exit 1
fi

enc=$(node -p "encodeURIComponent(process.argv[1])" "$name")
entry="$REGISTRY/v0/servers/$enc/versions/$version"
status=$(curl -s -o /dev/null -w '%{http_code}' "$entry")
case "$status" in
  200) echo "· $name $version is already listed: $entry"; exit 0 ;;
  404) ;;
  *) echo "::error::the registry answered $status for $entry; not publishing blind"; exit 1 ;;
esac

if ! npm view "$pkg@$pkg_v" version >/dev/null 2>&1; then
  echo "::error::$pkg@$pkg_v is not on npm, so the registry cannot verify it"
  exit 1
fi

if [ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]; then
  echo "::error::the pinned mcp-publisher is linux_amd64; this runner is $(uname -s)-$(uname -m)"
  exit 1
fi
tmp=$(mktemp -d)
curl -fsSL -o "$tmp/mcp-publisher.tar.gz" \
  "https://github.com/modelcontextprotocol/registry/releases/download/$PUBLISHER_VERSION/mcp-publisher_linux_amd64.tar.gz"
echo "$PUBLISHER_SHA256  $tmp/mcp-publisher.tar.gz" | sha256sum -c -
tar -xzf "$tmp/mcp-publisher.tar.gz" -C "$tmp" mcp-publisher

"$tmp/mcp-publisher" login github-oidc
"$tmp/mcp-publisher" publish

for _ in $(seq 1 12); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "$entry")" = 200 ]; then
    echo "✓ listed: $entry"
    exit 0
  fi
  sleep 5
done
echo "::error::published, but the registry still does not serve $name $version after 60 s: $entry"
exit 1
