# Build from the repo root so display and setup pages ship with the hub.
#   docker buildx build --platform linux/amd64,linux/arm64 -f hub/Dockerfile -t deskling-hub .
FROM node:22-alpine
# serialport uses udevadm to enumerate Linux USB devices.
RUN apk add --no-cache eudev
WORKDIR /app/hub
COPY hub/package.json hub/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY hub/src ./src
COPY web /app/web
COPY assets /app/assets
COPY LICENSE NOTICE /app/
# mDNS cannot reach a LAN from a container network and is pointless behind a domain.
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0 DATA_DIR=/data STATIC_DIR=/app MDNS=0
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8787
USER node
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "src/server.ts"]
