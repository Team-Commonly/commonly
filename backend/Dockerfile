# Build stage: dev dependencies are needed for tsc and never ship.
FROM node:22 AS build

WORKDIR /app

COPY package*.json ./

# Install all dependencies including dev dependencies
RUN npm install --include=dev

COPY . .

# Compile TypeScript to dist/
RUN npm run build

# Copy non-JS assets that tsc doesn't copy
RUN cp -r external dist/external 2>/dev/null || true

# Runtime stage
FROM node:22

WORKDIR /app

# OfficeCLI binary — used by the PPTX preview route to render .pptx → HTML
# server-side. Pinned by version and by the SHA-256 recorded below, so a
# future upstream artifact swap fails the build instead of silently shipping.
# The hashes are the release's SHA256SUMS entries, cross-checked against the
# downloaded assets on 2026-11-09. They are recorded here rather than fetched
# because that day the SHA256SUMS file returned intermittent 504s from
# GitHub's release CDN for over an hour, failing every backend build while the
# binaries themselves still downloaded. A hash stored in the repo also means a
# swapped release can't bring its own matching checksum. A version bump
# updates both hashes.
#
# This comment used to add "Same upstream + version as the gateway image."
# Same upstream, yes. Same version, no — and it cannot be, because the
# gateway does not pin. openclaw's Dockerfile pulls
# `releases/latest/download/${asset}` with no version and no checksum, so
# "same version" was true at most on the day it was written and drifts every
# time upstream publishes. Measured against both running containers
# 2026-08-05:
#
#   backend  (this file, pinned)      1.0.70
#   gateway  (openclaw, `latest`)     1.0.143   ← upstream latest, 2026-07-28
#
# Seventy-three releases apart, in one system, for the same file formats: this
# image renders .pptx for the preview route, the gateway extracts .docx/.pptx
# for commonly_read_attachment. Do not reason about one from the other.
#
# Deliberately not "fixed" by bumping to 1.0.143 — the pin is doing its job,
# and matching a floating target once just restarts the drift. The real fix is
# upstream pinning + checksum in openclaw's Dockerfile, which needs a PR there
# and a submodule bump; see the pin-skew entry in CLAUDE.md for why that is
# not a one-liner. Until then the divergence is a known, measured fact rather
# than a claim of sameness, and `officecli --version` in each container is the
# check that keeps it honest.
ARG OPENCLAW_OFFICECLI_VERSION=1.0.70
ARG OFFICECLI_SHA256_X64=654a4a9e651ce992f8352a3c6700feb5210a9cc64baaf093e773e69e858f54a9
ARG OFFICECLI_SHA256_ARM64=4a4a8d7c1149a9480e2d5057ef04e55f49bc67206f123886dee5ca12c20e0f8e
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git && \
    ARCH="$(uname -m)" && \
    case "$ARCH" in \
      x86_64)  ASSET="officecli-linux-x64";   EXPECTED="${OFFICECLI_SHA256_X64}" ;; \
      aarch64) ASSET="officecli-linux-arm64"; EXPECTED="${OFFICECLI_SHA256_ARM64}" ;; \
      *) echo "Unsupported architecture for OfficeCLI: $ARCH" >&2; exit 1 ;; \
    esac && \
    REL="https://github.com/iOfficeAI/OfficeCLI/releases/download/v${OPENCLAW_OFFICECLI_VERSION}" && \
    curl -fsSL --retry 4 --retry-all-errors --connect-timeout 10 --speed-limit 1024 --speed-time 30 "${REL}/${ASSET}" -o /usr/local/bin/officecli && \
    ( cd /usr/local/bin && echo "${EXPECTED}  officecli" | sha256sum -c - ) && \
    chmod +x /usr/local/bin/officecli && \
    officecli --version && \
    git --version && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Parse stored agent cards locally; never send install/runtime telemetry.
ENV OPENUI_TELEMETRY_DISABLED=1

COPY package*.json ./

# Production dependencies only. Dev tooling (jest, eslint, ts-node, typescript,
# mongodb-memory-server, ...) stays in the build stage and never reaches prod.
RUN npm ci --omit=dev

COPY . .

# Compiled output from the build stage: dist/ with config/ and external/ in place
COPY --from=build /app/dist ./dist

EXPOSE 5000

# Add a label to indicate testing is supported
LABEL com.commonly.testing="true"

# Make the startup script executable
RUN chmod +x /app/start.sh

# Use the startup script as the default command
CMD ["/bin/bash", "/app/start.sh"]
