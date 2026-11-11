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

# curl, CA certificates and git for the runtime. The OfficeCLI binary used to
# be installed here for the PPTX preview route; that route was retired (F405,
# #3878) and nothing else in this image runs it, so it was dropped (F408). The
# bundled officecli skill runs in agent runtimes, not in this image.
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
