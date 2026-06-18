# FIELD backend — Cloud Run ready.
# better-sqlite3 is a native module, so we need a toolchain to build it.
FROM node:20-slim

# Build deps for better-sqlite3 (python3 + g++ + make) and curl for healthcheck.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# Cloud Run injects PORT (8080). SQLite must live in the only writable dir: /tmp.
# NOTE: /tmp is EPHEMERAL on Cloud Run — the DB resets on cold start. Demo only.
ENV PORT=8080
ENV DB_PATH=/tmp/field.db
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://127.0.0.1:8080/health || exit 1

CMD ["node", "dist/server.js"]
