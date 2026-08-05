#!/usr/bin/env bash
set -Eeuo pipefail

# Shared helpers for the Agrovix development runtime.

DEV_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$DEV_SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.yml"
RUNTIME_DIR="$REPO_ROOT/.runtime"
COMPOSE_SERVICES=(postgres redis api web)

compose_project_name_for_path() {
  local checkout_path="$1" directory sanitized checksum
  directory="$(basename -- "$checkout_path")"
  sanitized="$(printf '%s' "$directory" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/-/g; s/^[^a-z0-9]*//; s/[^a-z0-9]*$//')"
  [[ -n "$sanitized" ]] || sanitized="agrovix"
  checksum="$(printf '%s' "$checkout_path" | cksum | awk '{printf "%08x", $1}')"
  printf 'agrovix-%s-%s\n' "$sanitized" "${checksum:0:8}"
}

if [[ -n "${AGROVIX_COMPOSE_PROJECT:-}" ]]; then
  [[ "$AGROVIX_COMPOSE_PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || {
    printf '  [error] AGROVIX_COMPOSE_PROJECT must match ^[a-z0-9][a-z0-9_-]*$.\n' >&2
    return 1
  }
  COMPOSE_PROJECT_NAME="$AGROVIX_COMPOSE_PROJECT"
else
  COMPOSE_PROJECT_NAME="$(compose_project_name_for_path "$REPO_ROOT")"
fi

compose() {
  docker compose --project-directory "$REPO_ROOT" --project-name "$COMPOSE_PROJECT_NAME" \
    --file "$COMPOSE_FILE" "$@"
}

info() { printf '==> %s\n' "$*"; }
ok() { printf '  [ok] %s\n' "$*"; }
warn() { printf '  [warn] %s\n' "$*" >&2; }
fail() { printf '  [error] %s\n' "$*" >&2; return 1; }

ensure_runtime_dir() {
  case "$RUNTIME_DIR" in
    "$REPO_ROOT"/.runtime) ;;
    *) fail "Unsafe runtime directory: $RUNTIME_DIR"; return 1 ;;
  esac
  mkdir -p -- "$RUNTIME_DIR"
}

env_file_value() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 0
  awk -v wanted="$key" '
    /^[[:space:]]*#/ { next }
    {
      line=$0
      sub(/^[[:space:]]*export[[:space:]]+/, "", line)
      split(line, pair, "=")
      name=pair[1]
      gsub(/[[:space:]]/, "", name)
      if (name == wanted) {
        sub(/^[^=]*=/, "", line)
        sub(/[[:space:]]+#.*/, "", line)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)
        gsub(/^['\"]|['\"]$/, "", line)
        print line
        exit
      }
    }
  ' "$file"
}

refuse_production() {
  local source value normalized
  for source in "environment:${APP_ENV:-}" "$REPO_ROOT/.env:$(env_file_value "$REPO_ROOT/.env" APP_ENV)" "$REPO_ROOT/apps/api/.env:$(env_file_value "$REPO_ROOT/apps/api/.env" APP_ENV)"; do
    value="${source#*:}"
    normalized="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
    if [[ "$normalized" == "production" || "$normalized" == "prod" ]]; then
      fail "Refusing developer runtime operation: APP_ENV is production (${source%%:*})."
      return 1
    fi
  done
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 || { fail "Required tool not found: $1"; return 1; }
}

require_tools() {
  local tool
  for tool in docker pnpm python curl git; do
    require_tool "$tool"
  done
  docker compose version >/dev/null 2>&1 || { fail "Docker Compose v2 is unavailable."; return 1; }
}

require_docker_daemon() {
  docker info >/dev/null 2>&1 || {
    fail "Docker daemon is unavailable. Check that Docker is running and that this user can access its socket."
    return 1
  }
}

require_files() {
  local path
  for path in docker-compose.yml package.json pnpm-lock.yaml apps/api/alembic.ini apps/web/package.json apps/web/next.config.js; do
    [[ -f "$REPO_ROOT/$path" ]] || { fail "Required file missing: $path"; return 1; }
  done
}

service_allowed() {
  local wanted="$1" service
  for service in "${COMPOSE_SERVICES[@]}"; do
    [[ "$service" == "$wanted" ]] && return 0
  done
  return 1
}

service_container_id() {
  compose ps -q "$1" 2>/dev/null
}

service_running() {
  local id
  id="$(service_container_id "$1")"
  [[ -n "$id" ]] && [[ "$(docker inspect --format '{{.State.Running}}' "$id" 2>/dev/null)" == "true" ]]
}

service_health() {
  local id
  id="$(service_container_id "$1")"
  [[ -n "$id" ]] || { printf 'stopped\n'; return; }
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{if .State.Running}}running{{else}}stopped{{end}}{{end}}' "$id" 2>/dev/null || printf 'unknown\n'
}

wait_for_service_health() {
  local service="$1" timeout="${2:-120}" elapsed=0 state
  while (( elapsed < timeout )); do
    state="$(service_health "$service")"
    [[ "$state" == "healthy" ]] && return 0
    sleep 2
    elapsed=$((elapsed + 2))
  done
  fail "Timed out waiting for $service to become healthy (final state: ${state:-unknown}). Diagnose with: scripts/dev/logs.sh $service"
}

ready_json() {
  python -c 'import json,sys
try:
    data=json.load(sys.stdin)
except Exception:
    raise SystemExit(1)
checks=data.get("checks", {})
raise SystemExit(0 if data.get("status") == "ready" and checks.get("database") is True and checks.get("redis") is True else 1)'
}

url_ready() {
  local url="$1"
  curl --silent --show-error --fail --max-time 5 "$url" 2>/dev/null | ready_json
}

wait_for_ready_url() {
  local label="$1" url="$2" timeout="${3:-120}" elapsed=0
  while (( elapsed < timeout )); do
    url_ready "$url" && return 0
    sleep 2
    elapsed=$((elapsed + 2))
  done
  fail "Timed out waiting for $label readiness at $url."
}

wait_for_http_200() {
  local label="$1" url="$2" timeout="${3:-120}" elapsed=0 code
  while (( elapsed < timeout )); do
    code="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 "$url" 2>/dev/null || true)"
    [[ "$code" == "200" ]] && return 0
    sleep 2
    elapsed=$((elapsed + 2))
  done
  fail "Timed out waiting for $label HTTP 200 at $url."
}

alembic_revisions() {
  local heads_output current_output head_count
  service_running api || { fail "API service is not running; cannot inspect Alembic revisions."; return 1; }
  heads_output="$(compose exec -T api alembic heads 2>/dev/null)"
  head_count="$(printf '%s\n' "$heads_output" | awk 'NF {count++} END {print count+0}')"
  [[ "$head_count" == "1" ]] || { fail "Expected exactly one Alembic head, found $head_count."; return 1; }
  ALEMBIC_HEAD="$(printf '%s\n' "$heads_output" | awk 'NF {print $1; exit}')"
  current_output="$(compose exec -T api alembic current 2>/dev/null)"
  ALEMBIC_CURRENT="$(printf '%s\n' "$current_output" | awk 'NF {print $1; exit}')"
  [[ -n "$ALEMBIC_CURRENT" ]] || ALEMBIC_CURRENT="<none>"
  if [[ "$ALEMBIC_CURRENT" == "$ALEMBIC_HEAD" ]]; then
    ALEMBIC_STATUS="at head"
    ALEMBIC_PENDING="false"
  else
    ALEMBIC_STATUS="pending"
    ALEMBIC_PENDING="true"
  fi
}

working_tree_state() {
  [[ -z "$(git -C "$REPO_ROOT" status --porcelain)" ]] && printf 'clean\n' || printf 'modified\n'
}
