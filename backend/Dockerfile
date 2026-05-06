FROM node:18

WORKDIR /app

# OfficeCLI binary — used by the PPTX preview route to render .pptx → HTML
# server-side. Same upstream + version as the gateway image. Pinned with
# SHA256 verification against the release's SHA256SUMS artifact so a future
# upstream artifact swap fails the build instead of silently shipping.
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
