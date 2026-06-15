#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Installing dependencies..."
pnpm install --frozen-lockfile

echo "==> Building LokiASAM..."
pnpm tauri build --no-bundle

echo "==> Packaging and installing via pacman..."
cd packaging/arch
makepkg -si
