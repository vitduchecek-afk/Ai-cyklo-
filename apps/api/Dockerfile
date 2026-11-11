# Build from the repository root: docker build -f apps/api/Dockerfile -t trailpack-api .
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @trailpack/api build

FROM node:22-alpine
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0
WORKDIR /app
COPY --from=build /repo/apps/api/dist ./dist
USER node
EXPOSE 8787
CMD ["node", "dist/server.js"]
