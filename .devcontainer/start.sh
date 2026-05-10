#!/usr/bin/env sh
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export PORT="${PORT:-443}"

sh "$ROOT/.devcontainer/setup-deps.sh"

if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    echo ".env created from .env.example — edit UUID if needed."
  fi
fi

if [ -f /tmp/vless-bun.pid ] && kill -0 "$(cat /tmp/vless-bun.pid)" 2>/dev/null; then
  echo "vless-bun already running (PID $(cat /tmp/vless-bun.pid))"
  exit 0
fi

nohup bun run dev >> /tmp/vless-bun.log 2>&1 &
echo $! > /tmp/vless-bun.pid
sleep 1
echo "vless-bun dev server PID $(cat /tmp/vless-bun.pid), PORT=${PORT}"
tail -n 30 /tmp/vless-bun.log 2>/dev/null || true
