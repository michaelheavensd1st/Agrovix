#!/usr/bin/env bash
set -Eeuo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

info "Agrovix developer runtime status"
printf '  Compose project: %s\n' "$COMPOSE_PROJECT_NAME"
printf '  Branch: %s\n' "$(git -C "$REPO_ROOT" branch --show-current 2>/dev/null || printf 'unknown')"
printf '  Working tree: %s\n' "$(working_tree_state)"
if [[ -n "${CODESPACE_NAME:-}" ]]; then
  printf '  Codespace: %s\n' "$CODESPACE_NAME"
fi

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  printf '\nCompose services:\n'
  compose ps --all || true
else
  warn "Docker Compose is unavailable."
fi

printf '\nHealth:\n'
printf '  PostgreSQL: %s\n' "$(service_health postgres)"
printf '  Redis: %s\n' "$(service_health redis)"
if url_ready "http://127.0.0.1:8000/api/v1/health/ready"; then
  printf '  Direct API readiness: ready\n'
else
  printf '  Direct API readiness: unavailable/not ready\n'
fi
web_code="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 3 http://127.0.0.1:3000/ 2>/dev/null || true)"
[[ -n "$web_code" && "$web_code" != "000" ]] || web_code="unavailable"
printf '  Web HTTP: %s\n' "${web_code:-unavailable}"
if url_ready "http://127.0.0.1:3000/api-proxy/v1/health/ready"; then
  printf '  Proxy readiness: ready\n'
else
  printf '  Proxy readiness: unavailable/not ready\n'
fi

printf '\nMigrations:\n'
if service_running api && alembic_revisions; then
  printf '  Current: %s\n' "$ALEMBIC_CURRENT"
  printf '  Head: %s\n' "$ALEMBIC_HEAD"
  printf '  Status: %s\n' "$ALEMBIC_STATUS"
else
  printf '  Current: unavailable (API stopped)\n'
  printf '  Head: unavailable (API stopped)\n'
  printf '  Status: unknown\n'
fi

if [[ -n "${CODESPACE_NAME:-}" ]] && command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  printf '\nForwarded ports:\n'
  gh codespace ports -c "$CODESPACE_NAME" 2>/dev/null || warn "Unable to read Codespaces port metadata."
fi
