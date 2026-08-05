#!/usr/bin/env bash
set -Eeuo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

info "Stopping Agrovix developer services for project $COMPOSE_PROJECT_NAME (volumes are preserved)"
compose stop web api redis postgres
ok "Agrovix services stopped; PostgreSQL and Redis volumes were preserved."
