# syntax=docker/dockerfile:1.7
#
# nandi-web: the Nandi frontend + the single public entry point (gateway).
#
#   /                 → the React app (static files, this image)
#   /config.js        → runtime config rendered from env (no rebuild per customer)
#   /api /auth /ws    → brain:8000
#   /health           → brain:8000
#   /vision/*         → vision:8765  (WebRTC signaling websocket)
#
# One build works on localhost, a LAN IP or a real domain; Caddy picks HTTP,
# a self-signed certificate (IP / localhost) or Let's Encrypt (domain) from
# NANDI_SITE_ADDRESS.

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# No VITE_* URLs on purpose: the app reads /config.js at runtime and otherwise
# talks to the origin it was served from.
RUN npm run build

FROM caddy:2.8.4-alpine
LABEL org.opencontainers.image.title="nandi-web" \
      org.opencontainers.image.description="Nandi AI assistant: web app + gateway"
COPY --from=build /app/dist /srv
COPY deploy/config.js.tmpl /srv/config.js
COPY deploy/Caddyfile /etc/caddy/Caddyfile
ENV NANDI_SITE_ADDRESS=":80" \
    NANDI_TLS_DEFAULT_SNI="localhost" \
    NANDI_PRODUCT_NAME="Nandi" \
    NANDI_GOOGLE_CLIENT_ID="" \
    NANDI_PUBLIC_ICE_SERVERS="" \
    NANDI_BRAIN_UPSTREAM="brain:8000" \
    NANDI_VISION_UPSTREAM="vision:8765"
EXPOSE 80 443
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:2019/config/ || exit 1
