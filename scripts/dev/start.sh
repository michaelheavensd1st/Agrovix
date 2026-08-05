#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

force_build=false
if (( $# > 1 )) || { (( $# == 1 )) && [[ "$1" != "--build" ]]; }; then
  fail "Usage: scripts/dev/start.sh [--build]"
  exit 2
fi
[[ "${1:-}" == "--build" ]] && force_build=true

"$SCRIPT_DIR/check.sh"

build_required="$force_build"
if [[ "$build_required" == "false" ]]; then
  for image in "$COMPOSE_PROJECT_NAME-api" "$COMPOSE_PROJECT_NAME-web"; do
    if ! docker image inspect "$image" >/dev/null 2>&1; then
      build_required=true
      warn "Required image $image is absent; an initial build is required."
      break
    fi
  done
fi

if [[ "$build_required" == "true" ]]; then
  info "Building API and web development images"
  compose build api web
  ok "Development images built"
else
  info "Using existing API and web images (no build requested)"
fi

info "Starting PostgreSQL, Redis, and FastAPI"
compose up -d postgres redis api
wait_for_service_health postgres 120
ok "PostgreSQL is healthy"
wait_for_service_health redis 120
ok "Redis is healthy"
wait_for_service_health api 180
wait_for_ready_url "API" "http://127.0.0.1:8000/api/v1/health/ready" 30
ok "FastAPI readiness is ready"

alembic_revisions
printf '  Alembic current: %s\n' "$ALEMBIC_CURRENT"
printf '  Alembic head: %s\n' "$ALEMBIC_HEAD"
if [[ "$ALEMBIC_PENDING" == "true" ]]; then
  warn "Database migrations are pending. Run scripts/dev/migrate.sh; start.sh will not migrate automatically."
else
  ok "Database migrations are at head"
fi

info "Starting Compose-managed Next.js"
compose up -d --no-deps web
wait_for_service_health web 180
wait_for_http_200 "web" "http://127.0.0.1:3000/" 30
wait_for_ready_url "proxied API" "http://127.0.0.1:3000/api-proxy/v1/health/ready" 30

info "Runtime readiness summary"
printf '  Web: %s (HTTP 200)\n' "$(service_health web)"
printf '  API: %s (ready)\n' "$(service_health api)"
printf '  PostgreSQL: %s\n' "$(service_health postgres)"
printf '  Redis: %s\n' "$(service_health redis)"
printf '  Migrations: %s (current=%s head=%s)\n' "$ALEMBIC_STATUS" "$ALEMBIC_CURRENT" "$ALEMBIC_HEAD"
printf '  Frontend: http://localhost:3000\n'
printf '  Proxied readiness: http://localhost:3000/api-proxy/v1/health/ready\n'
