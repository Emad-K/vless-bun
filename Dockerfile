# Use official Bun image
FROM oven/bun:alpine AS base
WORKDIR /app

# Install dependencies and build
FROM base AS build
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile || bun install
COPY . .
RUN bun run build

# Production image
FROM base AS release
COPY --from=build /app/dist ./dist

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Expose port
EXPOSE 3000

# Run the compiled JS file
USER bun
CMD ["bun", "run", "dist/index.js"]
