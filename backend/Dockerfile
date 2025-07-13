FROM node:18

WORKDIR /app

COPY package*.json ./

# Install all dependencies including dev dependencies
RUN npm install --include=dev

COPY . .

EXPOSE 5000

# Add a label to indicate testing is supported
LABEL com.commonly.testing="true"

# Make the startup script executable
RUN chmod +x /app/start.sh

# Use the startup script as the default command
CMD ["/bin/bash", "/app/start.sh"]
