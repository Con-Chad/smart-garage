#!/bin/sh
# Smoke-test every /api/v1 read endpoint against a running server.
#
#   SG_BASE_URL=http://localhost:3000 SG_USERNAME=me SG_PASSWORD=secret scripts/api-smoke.sh
#
# Through Cloudflare Access, also set CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET.
# Signs in as a temporary device ("api-smoke") and revokes it again at the end.
# Read-only apart from that device row. Needs only POSIX sh and curl.
set -eu

BASE="${SG_BASE_URL:?set SG_BASE_URL, e.g. http://localhost:3000}"
BASE="${BASE%/}/api/v1"
USERNAME="${SG_USERNAME:?set SG_USERNAME}"
PASSWORD="${SG_PASSWORD:?set SG_PASSWORD}"

TMP="$(mktemp -d)"
TOKEN=""
FAILURES=0

cleanup() {
  if [ -n "$TOKEN" ]; then
    request POST auth/logout >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

# request METHOD PATH [JSON_BODY] -> prints the HTTP status; body in $TMP/body
request() {
  method="$1"
  path="$2"
  set -- -sS -o "$TMP/body" -w '%{http_code}' -X "$method" \
    -H 'accept: application/json' -H 'user-agent: smart-garage-api-smoke'
  if [ -n "${CF_ACCESS_CLIENT_ID:-}" ]; then
    set -- "$@" -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
      -H "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET:?set CF_ACCESS_CLIENT_SECRET too}"
  fi
  if [ -n "$TOKEN" ]; then
    set -- "$@" -H "authorization: Bearer $TOKEN"
  fi
  if [ -n "${BODY:-}" ]; then
    set -- "$@" -H 'content-type: application/json' --data "$BODY"
  fi
  curl "$@" "$BASE/$path"
}

# check PATH [EXPECTED_STATUS]
check() {
  expected="${2:-200}"
  status="$(request GET "$1" || echo 000)"
  if [ "$status" = "$expected" ]; then
    printf '  ok   %s %s\n' "$status" "$1"
  else
    printf '  FAIL %s %s (expected %s): %s\n' "$status" "$1" "$expected" "$(head -c 200 "$TMP/body")"
    FAILURES=$((FAILURES + 1))
  fi
}

# First `"id":"..."` in the last response body, or empty.
first_id() {
  sed -n 's/^{"items":\[{"id":"\([^"]*\)".*/\1/p' "$TMP/body"
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

echo "[api-smoke] $BASE"
check health

BODY="{\"username\":\"$(json_escape "$USERNAME")\",\"password\":\"$(json_escape "$PASSWORD")\",\"deviceName\":\"api-smoke\"}"
status="$(request POST auth/login)"
BODY=""
if [ "$status" != "201" ]; then
  echo "[api-smoke] login failed with HTTP $status: $(head -c 300 "$TMP/body")" >&2
  exit 1
fi
TOKEN="$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$TMP/body")"
echo "  ok   201 auth/login"

for path in me devices preferences notification-settings note-tags reminders \
  "expenses/summary?groupBy=month" "expenses/summary?groupBy=category" \
  "sync?limit=50"; do
  check "$path"
done

for collection in vehicles modifications custom-fields custom-field-values schedules \
  records fuel odometer expenses documents inspections insurance notes wishlist templates; do
  check "$collection?limit=1"
  id="$(first_id)"
  if [ -n "$id" ]; then
    check "$collection/$id"
    if [ "$collection" = "documents" ]; then
      check "documents/$id/content"
    fi
    if [ "$collection" = "vehicles" ]; then
      status="$(request GET "vehicles/$id/shares")"
      case "$status" in
        200 | 403) printf '  ok   %s vehicles/%s/shares\n' "$status" "$id" ;;
        *) printf '  FAIL %s vehicles/%s/shares\n' "$status" "$id"; FAILURES=$((FAILURES + 1)) ;;
      esac
    fi
  fi
done

check "fuel/does-not-exist" 404
check "fuel?cursor=garbage" 400

saved="$TOKEN"
TOKEN=""
check me 401
TOKEN="$saved"

if [ "$FAILURES" -gt 0 ]; then
  echo "[api-smoke] $FAILURES check(s) failed" >&2
  exit 1
fi
echo "[api-smoke] all checks passed"
