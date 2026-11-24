# Build stage: dev dependencies are needed for tsc and never ship.
# Both stages name the Debian release, so a change of the floating default
# under node:22 can't move the image to a new distro unannounced.
FROM node:22-bookworm AS build

WORKDIR /app

COPY package*.json ./

# @openuidev/lang-core's postinstall sends install telemetry unless this is
# set, and this stage installs before the runtime stage's ENV below applies.
ENV OPENUI_TELEMETRY_DISABLED=1

# Install all dependencies including dev dependencies
RUN npm install --include=dev

COPY . .

# Compile TypeScript to dist/
RUN npm run build

# Copy non-JS assets that tsc doesn't copy
RUN cp -r external dist/external 2>/dev/null || true

# Runtime stage: the slim base. The full node:22 image carries a compiler
# toolchain, kernel headers and dev libraries that nothing here runs, and they
# were most of the live image's fixable CVEs. No production dependency builds
# native code (the only install scripts, protobufjs and @openuidev/lang-core,
# are plain node), playwright-core only connects to a remote browser over CDP,
# and the only binaries the server runs are git (installed below) and docker
# (local provisioner only). The tag floats on purpose: nothing bumps a digest
# pin here, so each build takes the current Debian security fixes.
FROM node:22-bookworm-slim

WORKDIR /app

# curl, CA certificates and git for the runtime. The OfficeCLI binary used to
# be installed here for the PPTX preview route; that route was retired (F405,
# #3878) and nothing else in this image runs it, so it was dropped (F408). No
# agent turn runs in this image, so the bundled officecli skill never used it.
# History and the old pin: docs/deployment/build-arg-history.md.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git && \
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
