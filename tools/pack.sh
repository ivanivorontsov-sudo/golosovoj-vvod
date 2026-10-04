#!/usr/bin/env bash
# Собирает dist/golosovoj-vvod-<версия>.zip из папки extension/ (нужен python3)
set -euo pipefail
cd "$(dirname "$0")/.."
V=$(node -p "require('./extension/manifest.json').version")
mkdir -p dist
OUT="dist/golosovoj-vvod-$V.zip"
rm -f "$OUT"
python3 - "$OUT" <<'PY'
import os, sys, zipfile
out = sys.argv[1]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for root, dirs, files in os.walk('extension'):
        dirs.sort()
        for f in sorted(files):
            if f.endswith('~') or f == '.DS_Store':
                continue
            p = os.path.join(root, f)
            z.write(p, os.path.join('golosovoj-vvod', os.path.relpath(p, 'extension')))
PY
ls -la "$OUT"
