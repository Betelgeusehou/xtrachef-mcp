# Playwright base (Chromium + system deps) pinned to the playwright version in package.json.
# The image ships Node 24; the service targets Node 22 (.node-version), so Node 22 is copied in.
FROM node:22-bookworm-slim AS node22

FROM mcr.microsoft.com/playwright:v1.64.0-noble
COPY --from=node22 /usr/local/bin/node /usr/local/bin/node
COPY --from=node22 /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && node --version | grep -q '^v22\.'

ENV NODE_ENV=production \
    XTRACHEF_MCP_MODE=http \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    TZ=America/Chicago

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .

EXPOSE 3000
CMD ["node", "src/main.js"]
