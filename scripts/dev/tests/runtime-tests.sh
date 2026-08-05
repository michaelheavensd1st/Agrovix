#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
TEST_TMP="$(mktemp -d)"
trap 'case "$TEST_TMP" in /tmp/*) rm -rf -- "$TEST_TMP" ;; esac' EXIT

pass() { printf 'ok - %s\n' "$1"; }
die() { printf 'not ok - %s\n' "$1" >&2; exit 1; }

name_one="$(bash -c 'source "$1/common.sh"; compose_project_name_for_path /tmp/agrovix-one' _ "$SCRIPT_DIR")"
name_one_repeat="$(bash -c 'source "$1/common.sh"; compose_project_name_for_path /tmp/agrovix-one' _ "$SCRIPT_DIR")"
name_two="$(bash -c 'source "$1/common.sh"; compose_project_name_for_path /tmp/agrovix-two' _ "$SCRIPT_DIR")"
[[ "$name_one" == "$name_one_repeat" && "$name_one" != "$name_two" ]] || die "checkout-specific project naming"
pass "checkout-specific project naming is stable and distinct"

if APP_ENV=prod "$SCRIPT_DIR/start.sh" >"$TEST_TMP/production.out" 2>&1; then
  die "production refusal"
fi
grep -q "APP_ENV is production" "$TEST_TMP/production.out" || die "production refusal diagnostic"
pass "start refuses production"

mkdir -p "$TEST_TMP/bin"
cat >"$TEST_TMP/bin/docker" <<'EOF'
#!/usr/bin/env bash
case " $* " in
  *" compose "*" version "*) exit 0 ;;
  *" info "*) exit 1 ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$TEST_TMP/bin/docker"
if PATH="$TEST_TMP/bin:$PATH" "$SCRIPT_DIR/check.sh" >"$TEST_TMP/daemon.out" 2>&1; then
  die "Docker daemon unavailable handling"
fi
grep -q "Docker daemon is unavailable" "$TEST_TMP/daemon.out" || die "Docker daemon diagnostic"
pass "preflight reports an unavailable Docker daemon"

cat >"$TEST_TMP/bin/docker" <<'EOF'
#!/usr/bin/env bash
arguments=" $* "
if [[ "$arguments" == *" ps -q api "* ]]; then
  printf 'fake-api-id\n'
elif [[ "$arguments" == *" inspect "* ]]; then
  printf 'true\n'
elif [[ "$arguments" == *" exec "* ]]; then
  [[ -n "${AGROVIX_UAT_PASSWORD+x}" ]] || exit 42
  printf 'present\n' >"$TEST_RESULT"
fi
EOF
chmod +x "$TEST_TMP/bin/docker"
export TEST_RESULT="$TEST_TMP/password-forwarded"
if ! printf 'prompt-owned-value\n' | env -u AGROVIX_UAT_PASSWORD PATH="$TEST_TMP/bin:$PATH" "$SCRIPT_DIR/bootstrap-uat.sh" >"$TEST_TMP/bootstrap.out" 2>&1; then
  die "prompt-owned UAT password forwarding"
fi
[[ "$(cat "$TEST_RESULT")" == "present" ]] || die "prompt-owned UAT password presence"
if grep -q "prompt-owned-value" "$TEST_TMP/bootstrap.out"; then
  die "prompt-owned UAT password secrecy"
fi
pass "prompt-owned UAT password is exported by name without disclosure"

if "$SCRIPT_DIR/logs.sh" invalid >"$TEST_TMP/logs.out" 2>&1; then
  die "invalid logs service rejection"
fi
grep -q "Unknown service" "$TEST_TMP/logs.out" || die "invalid logs service diagnostic"
pass "logs rejects invalid services"

if printf 'no\n' | "$SCRIPT_DIR/reset.sh" >"$TEST_TMP/reset.out" 2>&1; then
  die "reset confirmation requirement"
fi
grep -q "Reset cancelled" "$TEST_TMP/reset.out" || die "reset cancellation diagnostic"
pass "reset requires typed confirmation"

grep -q 'compose build api web' "$SCRIPT_DIR/start.sh" || die "explicit build path"
if grep -Eq 'compose up .*--build' "$SCRIPT_DIR/start.sh"; then
  die "default start build behavior"
fi
pass "start builds explicitly and never passes --build to daily compose up"

bash -n "$SCRIPT_DIR"/*.sh
pass "runtime scripts parse with Bash without Bash-4-only mapfile"
