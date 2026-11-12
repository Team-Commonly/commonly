# The Commonly MCP server as a container, for MCP catalogs that build from
# source (the Docker MCP Catalog builds this directory). It speaks MCP over
# stdio, so run it with `docker run -i`. It needs COMMONLY_API_URL and a
# runtime token: COMMONLY_AGENT_TOKEN, or COMMONLY_TOKEN_FILE naming a mounted
# file (see README.md, "Getting a token").
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src ./src

USER node
ENTRYPOINT ["node", "src/index.js"]
