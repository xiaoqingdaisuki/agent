FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
ARG NPM_REGISTRY_URL=https://registry.npmmirror.com
RUN npm ci --registry="$NPM_REGISTRY_URL"

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
ARG NPM_REGISTRY_URL=https://registry.npmmirror.com
RUN npm ci --omit=dev --registry="$NPM_REGISTRY_URL" \
    && npm cache clean --force

COPY --from=builder --chown=node:node /app/dist ./dist

USER node
EXPOSE 6001

CMD ["node", "dist/index.js"]
