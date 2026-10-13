# Production image for Fly.io. Built remotely by `fly deploy` — no local
# Docker needed.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
# rclone copies the uploads and the daily database snapshots to Cloudflare R2
# (off-site backup, only when the R2_* secrets are set); ca-certificates for
# its HTTPS calls
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates rclone \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY boot.sh ./boot.sh
EXPOSE 8080
CMD ["sh", "./boot.sh"]
