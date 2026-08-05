#!/usr/bin/env bash
set -Eeuo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

refuse_production
service_running api || { fail "API service is not running. Run scripts/dev/start.sh first."; exit 1; }

owned_password=false
if [[ -z "${AGROVIX_UAT_PASSWORD:-}" ]]; then
  read -r -s -p "UAT password: " AGROVIX_UAT_PASSWORD
  printf '\n'
  [[ -n "$AGROVIX_UAT_PASSWORD" ]] || { fail "The UAT password cannot be empty."; unset AGROVIX_UAT_PASSWORD; exit 1; }
  export AGROVIX_UAT_PASSWORD
  owned_password=true
fi

cleanup_password() {
  if [[ "$owned_password" == "true" ]]; then
    unset AGROVIX_UAT_PASSWORD
  fi
}
trap cleanup_password EXIT

exec_args=(-T -e AGROVIX_UAT_PASSWORD)
for optional_name in AGROVIX_UAT_EMAIL AGROVIX_UAT_ORG_NAME AGROVIX_UAT_FARM_NAME; do
  [[ -n "${!optional_name:-}" ]] && exec_args+=(-e "$optional_name")
done

compose exec "${exec_args[@]}" api python -m app.scripts.bootstrap_uat
