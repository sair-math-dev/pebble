# syntax=docker/dockerfile:1
# Supply the generated NODE_IMAGE=...@sha256:... from deployment/images.env.
ARG NODE_IMAGE
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY deployment/tsconfig.build.json ./deployment/tsconfig.build.json
COPY src ./src
RUN ./node_modules/.bin/tsc -p deployment/tsconfig.build.json
RUN npm prune --omit=dev && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node deployment/healthcheck.mjs ./deployment/healthcheck.mjs
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=4s --start-period=20s --retries=3 CMD ["node", "deployment/healthcheck.mjs"]
ENTRYPOINT ["node", "dist/main.js"]
CMD ["serve"]

# Only for a runtime which passes the namespace probe. The production worker
# deployment uses a dedicated Linux VM; this target grants no extra privileges.
FROM runtime AS worker
USER root
RUN apt-get update && apt-get install --no-install-recommends -y bubblewrap ca-certificates util-linux && rm -rf /var/lib/apt/lists/*
COPY --chown=node:node deployment/worker-preflight.mjs ./deployment/worker-preflight.mjs
COPY --chown=node:node deployment/worker-entrypoint.mjs ./deployment/worker-entrypoint.mjs
USER node
HEALTHCHECK NONE
ENTRYPOINT ["node", "deployment/worker-entrypoint.mjs"]

# The default target serves HTTP; publishing a worker image requires --target worker.
FROM runtime AS api
