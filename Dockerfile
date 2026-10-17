FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/ ./scripts/
RUN npm ci
COPY . .
ARG SOURCE_COMMIT
ARG RELEASE_TAG
ENV CW_SOURCE_COMMIT=$SOURCE_COMMIT RELEASE_TAG=$RELEASE_TAG
RUN node scripts/set-release-version.mjs && npm run typecheck && npm test && npm run build:web && node scripts/smoke-connectors.mjs && node scripts/audit-rc-widgets.mjs

FROM nginx:stable-alpine
COPY deployment/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/ /usr/share/nginx/html/
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s CMD wget -q -O /dev/null http://127.0.0.1/version.json || exit 1
