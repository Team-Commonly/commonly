FROM node:18

WORKDIR /app

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
