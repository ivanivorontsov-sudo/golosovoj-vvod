#!/usr/bin/env bash
# Собирает dist/golosovoj-vvod-<версия>.zip из папки extension/
set -euo pipefail
cd "$(dirname "$0")/.."
V=$(node -p "require('./extension/manifest.json').version")
mkdir -p dist
OUT="dist/golosovoj-vvod-$V.zip"
rm -f "$OUT"
(cd extension && zip -qr -9 "../$OUT" . -x '*.DS_Store' -x '*~')
ls -la "$OUT"
