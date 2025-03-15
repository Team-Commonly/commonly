FROM node:16 as build-stage

WORKDIR /app

COPY package*.json ./

RUN npm install

# Copy the .env file first (if it exists) to ensure it's used during the build
COPY .env* ./

COPY . .

# Add build arguments for environment variables
ARG REACT_APP_API_URL
ENV REACT_APP_API_URL=${REACT_APP_API_URL}
# Ensure ESLint warnings don't fail the build
ENV CI=false

RUN npm run build

FROM nginx:alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=build-stage /app/build /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
