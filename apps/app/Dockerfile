# One image for the application, the worker and the built web client: the worker is this image run
# with a different command, so the two can never drift apart in a deployment.
FROM node:24.20.0-slim AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json vitest.base.ts eslint.config.js .browserslistrc ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm turbo build --filter=@holydeck/app... --filter=@holydeck/worker... --filter=@holydeck/web...
RUN pnpm --filter @holydeck/app deploy --legacy --prod /out/app \
  && pnpm --filter @holydeck/worker deploy --legacy --prod /out/worker

FROM node:24.20.0-slim
ENV NODE_ENV=production
WORKDIR /srv
COPY --from=build /out/app ./app
COPY --from=build /out/worker ./worker
# The application serves this client from its own origin, and finds it at this path relative to its
# own dist directory — the same relative path the repository has, so dev and image agree.
COPY --from=build /repo/apps/web/dist ./web/dist
# An empty named volume mounted here inherits this ownership, so the worker can create what it owns.
RUN mkdir -p /data/holydeck && chown -R node:node /data/holydeck
USER node
EXPOSE 3000
# No HEALTHCHECK: the same image runs the worker, which serves no HTTP, so a check baked in here
# would mark a healthy worker unhealthy. Each service declares its own.
CMD ["node", "/srv/app/dist/main.js"]
