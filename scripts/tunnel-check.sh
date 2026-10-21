#!/bin/sh
# Checks that /api/v1 behind a Cloudflare Tunnel + Access is locked down the
# way the Android app expects: three layers, each one tested on its own.
#
#   SG_BASE_URL=https://garage-test.example.com \
#   CF_ACCESS_CLIENT_ID=xxxx.access CF_ACCESS_CLIENT_SECRET=yyyy \
#   SG_USERNAME=me SG_PASSWORD=secret \
#   scripts/tunnel-check.sh
#
#   1. No CF service-token headers      -> Cloudflare blocks it (403, or a 302 to the Access login)
#   2. CF headers, bad Smart Garage token -> the app answers 401
#   3. CF headers, real token            -> 200
#
# Signs in as a temporary device ("tunnel-check") and revokes it at the end.
# Needs only POSIX sh and curl.
set -eu

BASE="${SG_BASE_URL:?set SG_BASE_URL, e.g. https://garage-test.example.com}"
BASE="${BASE%/}/api/v1"
CF_ID="${CF_ACCESS_CLIENT_ID:?set CF_ACCESS_CLIENT_ID}"
CF_SECRET="${CF_ACCESS_CLIENT_SECRET:?set CF_ACCESS_CLIENT_SECRET}"
USERNAME="${SG_USERNAME:?set SG_USERNAME}"
PASSWORD="${SG_PASSWORD:?set SG_PASSWORD}"

TMP="$(mktemp -d)"
TOKEN=""
FAILURES=0

# call [--cf] METHOD PATH [BEARER] [JSON] -> prints status; body in $TMP/body, headers in $TMP/headers
call() {
  cf=""
  if [ "$1" = "--cf" ]; then cf=1; shift; fi
  method="$1"; path="$2"; bearer="${3:-}"; body="${4:-}"
  set -- -sS -o "$TMP/body" -D "$TMP/headers" -w '%{http_code}' -X "$method" \
    -H 'accept: application/json' -H 'user-agent: smart-garage-tunnel-check'
  if [ -n "$cf" ]; then
    set -- "$@" -H "CF-Access-Client-Id: $CF_ID" -H "CF-Access-Client-Secret: $CF_SECRET"
  fi
  if [ -n "$bearer" ]; then set -- "$@" -H "authorization: Bearer $bearer"; fi
  if [ -n "$body" ]; then set -- "$@" -H 'content-type: application/json' --data "$body"; fi
  curl "$@" "$BASE/$path" || echo 000
}

cleanup() {
  if [ -n "$TOKEN" ]; then call --cf POST auth/logout "$TOKEN" >/dev/null 2>&1 || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

pass() { printf '  ok   %s\n' "$1"; }
fail() {
  printf '  FAIL %s\n       %s\n' "$1" "$(head -c 300 "$TMP/body" | tr '\n' ' ')"
  FAILURES=$((FAILURES + 1))
}

echo "[tunnel-check] $BASE"

# 1. Cloudflare must stop the request before it reaches the container.
status="$(call GET health)"
case "$status" in
  401 | 403 | 302)
    if grep -q '"service":"smart-garage"' "$TMP/body"; then
      fail "1. no CF headers: got $status but the body came from Smart Garage (Access isn't in front?)"
    else
      pass "1. no CF headers -> $status from Cloudflare"
    fi
    ;;
  200) fail "1. no CF headers -> 200: the API is reachable without a service token" ;;
  *) fail "1. no CF headers -> unexpected HTTP $status" ;;
esac

# 2. Past Access, the app's own auth must still hold.
status="$(call --cf GET me "sgd_this-token-is-not-real")"
if [ "$status" = "401" ] && grep -q '"code":"unauthorized"' "$TMP/body"; then
  pass "2. CF headers + bad bearer -> 401 from Smart Garage"
elif [ "$status" = "403" ] || [ "$status" = "302" ]; then
  fail "2. CF headers + bad bearer -> $status: Cloudflare rejected the service token (check the Service Auth policy)"
else
  fail "2. CF headers + bad bearer -> HTTP $status (expected 401)"
fi

# 3. Both layers satisfied.
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
status="$(call --cf POST auth/login "" "{\"username\":\"$(esc "$USERNAME")\",\"password\":\"$(esc "$PASSWORD")\",\"deviceName\":\"tunnel-check\"}")"
if [ "$status" = "201" ]; then
  TOKEN="$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$TMP/body")"
  status="$(call --cf GET me "$TOKEN")"
  if [ "$status" = "200" ]; then
    pass "3. CF headers + real bearer -> 200 ($(sed -n 's/.*"username":"\([^"]*\)".*/\1/p' "$TMP/body"))"
  else
    fail "3. CF headers + real bearer -> HTTP $status (expected 200)"
  fi
else
  fail "3. login through the tunnel -> HTTP $status (expected 201)"
fi

# Informational: show the Cloudflare ray id of the last response.
if grep -qi '^cf-ray:' "$TMP/headers"; then
  pass "response came through Cloudflare ($(grep -i '^cf-ray:' "$TMP/headers" | tr -d '\r' | cut -d' ' -f2))"
fi

if [ "$FAILURES" -gt 0 ]; then
  echo "[tunnel-check] $FAILURES check(s) failed" >&2
  exit 1
fi
echo "[tunnel-check] all checks passed"
