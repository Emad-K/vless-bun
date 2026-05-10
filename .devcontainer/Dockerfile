# Dependencies are installed at IMAGE BUILD TIME (registry reachable from GitHub build infra).
# Runtime bind-mount hides /workspace layers — deps live under /deps and are symlinked into /workspace.
FROM oven/bun:alpine

RUN apk add --no-cache git curl ca-certificates

WORKDIR /deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

WORKDIR /workspace
ENV PORT=443
