#!/usr/bin/env bash
set -Eeuo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

if (( $# > 1 )); then
  fail "Usage: scripts/dev/logs.sh [api|web|postgres|redis]"
  exit 2
fi
if (( $# == 1 )); then
  service_allowed "$1" || { fail "Unknown service '$1'. Allowed: api, web, postgres, redis."; exit 2; }
  compose logs --no-color "$1"
else
  compose logs --no-color "${COMPOSE_SERVICES[@]}"
fi
