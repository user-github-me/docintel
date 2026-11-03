# syntax=docker/dockerfile:1.7
# Build context: repository root (needs db/migrations).  docker build -f apps/api/Dockerfile .
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY apps/api/package.json apps/api/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY apps/api/ ./
RUN npx nest build && npm prune --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production STORAGE_DIR=/data/storage PORT=4000
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
COPY db/migrations ./dist/migrations
# The node user (uid 1000) matches the processor image so the shared storage volume is writable.
RUN mkdir -p /data/storage/tmp && chown -R node:node /data /app
USER node
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD node -e "fetch('http://localhost:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(process.env.APP_ROLE==='worker'?0:1))"
CMD ["node", "dist/main.js"]
