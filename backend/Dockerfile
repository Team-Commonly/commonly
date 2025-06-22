FROM node:18

WORKDIR /app

COPY package*.json ./

# Install all dependencies including dev dependencies
RUN npm install --include=dev

COPY . .

EXPOSE 5000

# Add a label to indicate testing is supported
LABEL com.commonly.testing="true"

# The default command still starts the server
CMD ["node", "server.js"]
