# ── Stage 1: Build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# Inject build-time env vars (passed as build args from docker-compose)
ARG VITE_API_URL
ARG VITE_MAPTILER_KEY
ARG VITE_CESIUM_TOKEN
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_MAPTILER_KEY=$VITE_MAPTILER_KEY
ENV VITE_CESIUM_TOKEN=$VITE_CESIUM_TOKEN

RUN npm run build

# ── Stage 2: Serve ───────────────────────────────────────────────────────────
FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html

# Custom nginx config: serve SPA + proxy /api to backend
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
