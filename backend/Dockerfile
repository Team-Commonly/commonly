FROM node:22

WORKDIR /app

# OfficeCLI binary — used by the PPTX preview route to render .pptx → HTML
# server-side. Pinned with SHA256 verification against the release's
# SHA256SUMS artifact so a future upstream artifact swap fails the build
# instead of silently shipping.
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
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && \
    ARCH="$(uname -m)" && \
    case "$ARCH" in \
      x86_64)  ASSET="officecli-linux-x64" ;; \
      aarch64) ASSET="officecli-linux-arm64" ;; \
      *) echo "Unsupported architecture for OfficeCLI: $ARCH" >&2; exit 1 ;; \
    esac && \
    REL="https://github.com/iOfficeAI/OfficeCLI/releases/download/v${OPENCLAW_OFFICECLI_VERSION}" && \
    curl -fsSL "${REL}/${ASSET}" -o /usr/local/bin/officecli && \
    curl -fsSL "${REL}/SHA256SUMS" -o /tmp/officecli-SHA256SUMS && \
    ( cd /usr/local/bin && \
      EXPECTED="$(awk -v a="${ASSET}" '$2==a {print $1}' /tmp/officecli-SHA256SUMS)" && \
      if [ -z "$EXPECTED" ]; then echo "OfficeCLI SHA256 not found for ${ASSET}" >&2; exit 1; fi && \
      echo "${EXPECTED}  officecli" | sha256sum -c - ) && \
    rm -f /tmp/officecli-SHA256SUMS && \
    chmod +x /usr/local/bin/officecli && \
    officecli --version && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

# Install all dependencies including dev dependencies
RUN npm install --include=dev

COPY . .

# Compile TypeScript to dist/
RUN npx tsc -p tsconfig.build.json

# Copy non-JS assets that tsc doesn't copy
RUN cp config/schema.sql dist/config/schema.sql
RUN cp -r external dist/external 2>/dev/null || true

EXPOSE 5000

# Add a label to indicate testing is supported
LABEL com.commonly.testing="true"

# Make the startup script executable
RUN chmod +x /app/start.sh

# Use the startup script as the default command
CMD ["/bin/bash", "/app/start.sh"]
