# Accura — full stack in one image: API server + built web console + chromium.
# The agent's browser runs headless inside this container.

FROM node:22-bookworm

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7700

RUN npm install -g pnpm@11.5.3

WORKDIR /app

# Workspace manifests first for layer caching of the dependency install.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json eslint.config.mjs ./
COPY packages ./packages
COPY apps ./apps
COPY configs ./configs

RUN pnpm install --frozen-lockfile

# Chromium + its system dependencies for the in-container agent browser.
RUN pnpm --filter @accura/browser exec playwright install --with-deps chromium

RUN pnpm run build

EXPOSE 7700

CMD ["node", "apps/server/dist/main.js"]
