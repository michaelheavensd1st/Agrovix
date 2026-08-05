#!/usr/bin/env bash
set -Eeuo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

assume_yes=false
if (( $# > 1 )) || { (( $# == 1 )) && [[ "$1" != "--yes" ]]; }; then
  fail "Usage: scripts/dev/migrate.sh [--yes]"
  exit 2
fi
[[ "${1:-}" == "--yes" ]] && assume_yes=true

refuse_production
service_running postgres || { fail "PostgreSQL service is not running. Run scripts/dev/start.sh first."; exit 1; }
service_running api || { fail "API service is not running. Run scripts/dev/start.sh first."; exit 1; }
[[ "$(service_health postgres)" == "healthy" ]] || { fail "PostgreSQL is not healthy."; exit 1; }

alembic_revisions
printf 'Alembic current: %s\n' "$ALEMBIC_CURRENT"
printf 'Alembic head: %s\n' "$ALEMBIC_HEAD"
if [[ "$ALEMBIC_PENDING" == "false" ]]; then
  ok "Database is already at Alembic head."
  exit 0
fi

if [[ "$assume_yes" != "true" ]]; then
  read -r -p "Apply migrations to Alembic head? Type 'yes' to continue: " confirmation
  [[ "$confirmation" == "yes" ]] || { warn "Migration cancelled."; exit 1; }
fi

info "Applying Alembic migrations inside the API container"
compose exec -T api alembic upgrade head
alembic_revisions
[[ "$ALEMBIC_PENDING" == "false" ]] || { fail "Migration verification failed (current=$ALEMBIC_CURRENT head=$ALEMBIC_HEAD)."; exit 1; }
ok "Database migrated successfully to $ALEMBIC_HEAD."
