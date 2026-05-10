# VLESS Bun Server

A VLESS proxy server running on Bun with TypeScript and Docker support.

## Requirements

- [Bun](https://bun.sh/) v1.0+
- Docker (optional)

## Quick Start

### Local Development

```bash
# Install dependencies
bun install

# Copy environment file and configure
cp .env.example .env

# Run the server
bun run start

# Or with hot reload
bun run dev
```

### Docker

```bash
# Copy environment file and configure
cp .env.example .env

# Build and run with Docker Compose
docker-compose up -d

# Or build manually
docker build -t vless-bun .
docker run -p 3000:3000 --env-file .env vless-bun
```

### GitHub Codespaces

The [Dev Container](https://containers.dev/) in `.devcontainer/` sets `PORT=443`, forwards port **443** (labeled **public**), runs as **root** so binding to `443` works without extra capabilities, and starts **`bun run dev`** on each container start via `.devcontainer/start.sh`.

Dependencies (`zod`, etc.) are **`bun install`’d while the Docker image is built** (where registry access works) and stored under `/deps` in the image; `setup-deps.sh` symlinks the repo’s `node_modules` to that tree so the bind-mounted project does not need a working `bun install` at runtime (which often hits `ConnectionRefused` inside restricted codespaces). After you change `package.json` or `bun.lock`, run **Dev Containers: Rebuild Container** so the image is rebuilt and deps refresh.

Create a codespace from the repo; after it opens, check the **Ports** tab for the forwarded URL (still plain HTTP/WebSocket on that port, not TLS termination inside the app).

## Configuration

Edit `.env` file:

| Variable | Description | Default |
|----------|-------------|---------|
| `UUID` | Your unique VLESS UUID | `4c1fe881-420d-4c23-8b26-5bb66101687b` |
| `PROXYIP` | SOCKS5 `host`, `host:port`, or `user:password@host:port` (default port 1080). Password may contain `:` (split after first `:`). Outbound TCP exits through this proxy. | empty |
| `PORT` | Server port | `3000` |

## Usage

1. Start the server
2. Access `http://localhost:3000/{UUID}` to get your VLESS configuration
3. Import the configuration into your VLESS client (v2ray, clash-meta, etc.)

## API Endpoints

- `GET /` - Server info
- `GET /{UUID}` - Get VLESS client configuration
- `WebSocket /` - VLESS WebSocket endpoint

## Notes

- This server supports WebSocket transport only
- UDP proxy is only enabled for DNS (port 53)
- For production, place behind a reverse proxy with TLS (nginx, caddy, etc.)
