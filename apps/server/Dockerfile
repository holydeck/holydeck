FROM node:24.20.0-slim AS build
# The image ships Debian's chromium; puppeteer must not download a second copy.
ENV PUPPETEER_SKIP_DOWNLOAD=true
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json eslint.config.js ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm turbo build --filter=@holydeck/server...
RUN pnpm --filter @holydeck/server deploy --legacy --prod /out

FROM node:24.20.0-slim
ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    HOLYDECK_BROWSER_EXECUTABLE=/usr/bin/chromium
# Chromium backs HOLYDECK_BROWSER_FETCH=true; without it the server can only fetch over plain HTTP.
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium fonts-liberation ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.HOLYDECK_PORT ?? '3000') + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/server.js"]
