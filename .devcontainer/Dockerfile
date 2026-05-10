# Dev / Codespaces image — root can bind :443 without extra capabilities
FROM oven/bun:alpine

RUN apk add --no-cache git curl ca-certificates

WORKDIR /workspace

ENV PORT=443
