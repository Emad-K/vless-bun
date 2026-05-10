#!/usr/bin/env sh
# Link pre-installed modules from the image, or fall back to bun install (needs registry access).
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -d /deps/node_modules ]; then
  rm -rf "$ROOT/node_modules"
  ln -sfn /deps/node_modules "$ROOT/node_modules"
  echo "Dev container: linked node_modules from image (/deps)."
else
  echo "Dev container: no /deps/node_modules — running bun install (needs network)."
  bun install --frozen-lockfile || bun install
fi
