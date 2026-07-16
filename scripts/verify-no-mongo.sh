#!/usr/bin/env bash
# =========================================================================
# Verify that no production code depends on MongoDB.
#
# The pod preview shim (/app/backend/server.py, /app/frontend/*) is
# excluded from the scan — it is not shipped and is documented in
# PREVIEW_SHIM.md. This script exits non-zero if any production module
# under apps/ or packages/ imports motor / pymongo / mentions mongodb.
# =========================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "→ Scanning apps/ and packages/ for MongoDB references…"

MATCHES=$(
  grep -RIn --include="*.py" --include="*.ts" --include="*.tsx" \
       --include="*.js" --include="*.jsx" --include="*.json" \
       --exclude-dir=node_modules --exclude-dir=.next \
       --exclude-dir=dist --exclude-dir=build --exclude-dir=.turbo \
       -E "(from motor|import motor|from pymongo|import pymongo|mongodb://|MONGO_URL)" \
       "$ROOT/apps" "$ROOT/packages" 2>/dev/null || true
)

if [[ -n "$MATCHES" ]]; then
  echo "✗ MongoDB references found in production code:" >&2
  echo "$MATCHES" >&2
  exit 1
fi

echo "✓ No MongoDB references in apps/ or packages/. Production code is Postgres-only."
