FROM node:20 AS build-stage

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

# Add build arguments for environment variables
ARG VITE_API_URL
ARG REACT_APP_API_URL
ENV VITE_API_URL=${VITE_API_URL}
ENV REACT_APP_API_URL=${REACT_APP_API_URL}
# Ensure ESLint warnings don't fail the build
ENV CI=false

RUN npm run build

FROM nginx:alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=build-stage /app/build /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
