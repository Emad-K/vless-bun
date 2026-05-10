# Dependencies are installed at IMAGE BUILD TIME (registry reachable from GitHub build infra).
# Runtime repo bind-mount overlays the default WORKDIR — deps live under /deps and are symlinked into the repo root.
FROM oven/bun:alpine

RUN apk add --no-cache git curl ca-certificates

WORKDIR /deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

WORKDIR /workspaces
ENV PORT=443
