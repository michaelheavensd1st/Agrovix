#!/usr/bin/env bash
set -Eeuo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

info "Agrovix developer runtime preflight"
git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || { fail "Repository root is not a Git worktree."; exit 1; }
ok "Git repository: $REPO_ROOT"
printf '  Branch: %s\n' "$(git -C "$REPO_ROOT" branch --show-current)"
printf '  Working tree: %s\n' "$(working_tree_state)"

refuse_production
ok "Non-production environment"
require_files
ok "Required runtime files present"
require_tools
ok "Required tools available"
require_docker_daemon
ok "Docker daemon available"

ensure_runtime_dir
[[ -w "$RUNTIME_DIR" ]] || { fail "Runtime directory is not writable: $RUNTIME_DIR"; exit 1; }
ok "Runtime directory writable"

compose config --quiet
configured_services="$(compose config --services)"
for expected in "${COMPOSE_SERVICES[@]}"; do
  printf '%s\n' "$configured_services" | grep -Fxq "$expected" || { fail "Compose service missing: $expected"; exit 1; }
done
ok "Compose configuration contains postgres, redis, api, and web"

printf '  Docker: %s\n' "$(docker --version)"
printf '  Compose: %s\n' "$(docker compose version --short)"
printf '  pnpm: %s\n' "$(pnpm --version)"
printf '  Python: %s\n' "$(python --version 2>&1)"
printf '  Git: %s\n' "$(git --version)"
printf '  Compose project: %s\n' "$COMPOSE_PROJECT_NAME"
