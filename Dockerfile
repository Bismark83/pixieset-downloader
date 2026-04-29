# ── Stage 1: Build the React client ──────────────────────────────────────────
FROM node:20-slim AS client-builder

WORKDIR /app/client
COPY client/package*.json ./
RUN npm install --legacy-peer-deps
COPY client/ ./
RUN npm run build

# ── Stage 2: Production server with Playwright + Chromium ────────────────────
FROM mcr.microsoft.com/playwright:v1.43.0-jammy

WORKDIR /app

# Install server dependencies
COPY server/package*.json ./server/
RUN cd server && npm install --production

# Copy server source
COPY server/ ./server/

# Copy built React files from Stage 1
COPY --from=client-builder /app/client/dist ./client/dist

# Install Playwright Chromium browser
RUN cd server && npx playwright install chromium

# Environment
ENV NODE_ENV=production

# Let Railway assign the PORT
CMD ["node", "server/index.js"]
