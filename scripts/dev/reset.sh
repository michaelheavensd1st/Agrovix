#!/usr/bin/env bash
set -Eeuo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

assume_yes=false
if (( $# > 1 )) || { (( $# == 1 )) && [[ "$1" != "--yes" ]]; }; then
  fail "Usage: scripts/dev/reset.sh [--yes]"
  exit 2
fi
[[ "${1:-}" == "--yes" ]] && assume_yes=true

refuse_production
printf 'WARNING: This deletes the checkout-scoped PostgreSQL, Redis, and Next.js state volumes.\n'
printf '  Compose project: %s\n' "$COMPOSE_PROJECT_NAME"
printf '  Volumes: %s_postgres_data, %s_redis_data, %s_web_next\n' "$COMPOSE_PROJECT_NAME" "$COMPOSE_PROJECT_NAME" "$COMPOSE_PROJECT_NAME"
if [[ "$assume_yes" != "true" ]]; then
  read -r -p "Type 'delete agrovix data' to continue: " confirmation
  [[ "$confirmation" == "delete agrovix data" ]] || { warn "Reset cancelled."; exit 1; }
fi

compose down --volumes
case "$RUNTIME_DIR" in
  "$REPO_ROOT"/.runtime) rm -rf -- "$RUNTIME_DIR" ;;
  *) fail "Refusing to remove unsafe runtime path: $RUNTIME_DIR"; exit 1 ;;
esac
ok "Agrovix developer containers, network, and data volumes were removed."
