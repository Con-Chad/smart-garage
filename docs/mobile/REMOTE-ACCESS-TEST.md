# Remote access test (CP5)

The Android app reaches Smart Garage through a Cloudflare Tunnel. That's
outbound-only, so no ports are forwarded. Two separate locks sit in front of
the data:

1. **Cloudflare Access** lets a request through only when it carries the
   app's service token (`CF-Access-Client-Id` and `CF-Access-Client-Secret`
   headers).
2. **Smart Garage** then requires its own device token
   (`Authorization: Bearer sgd_…`), issued at sign-in and revocable under
   **Settings → Mobile devices**.

This test runs a **second container on a copy of your data**, so production
is never touched. Values in `<<double angle brackets>>` are yours to fill in.

## 1. Copy the data

In the Unraid terminal, stop the production container for a few seconds so
the SQLite file is consistent, copy it, and start production again:

```sh
docker stop <<production container name, e.g. smart-garage>>
cp -a /mnt/user/appdata/smart-garage /mnt/user/appdata/smart-garage-test
docker start <<production container name>>
```

Also keep that copy as a backup. Make one again before production ever
switches to the fork's image.

## 2. Make the image pullable

GitHub creates new container packages as **private**. Either:

- **Make it public** (recommended, since the code is public anyway):
  github.com → your profile → **Packages** → `smart-garage` →
  **Package settings** → **Change visibility** → Public; or
- keep it private and add a GitHub token with `read:packages` as registry
  credentials on Unraid.

## 3. Add the test container

**Docker** → **Add Container**:

| Field | Value |
|---|---|
| Name | `smart-garage-test` |
| Repository | `ghcr.io/con-chad/smart-garage:latest` |
| Port | host `<<free port, e.g. 3001>>` → container `3000` |
| Path | host `/mnt/user/appdata/smart-garage-test` → container `/data` |
| Variable `DEFAULT_LOCALE` | `en` |
| Variable `DEFAULT_TIMEZONE` | `America/Chicago` |
| Variable `DEFAULT_CURRENCY` | `USD` |
| Variable `DEFAULT_DISTANCE_UNIT` | `mi` |
| Variable `DEFAULT_VOLUME_UNIT` | `gal` |

The `DEFAULT_*` variables only apply to accounts created from now on. Your
existing account keeps its settings, so set **Settings → Regional** to
miles, gallons, USD and America/Chicago once.

On first start the container applies the new, purely additive migrations
(device tokens, sync tombstones, idempotency keys) to the **copy**. Check
`http://<<unraid LAN IP>>:<<port>>/api/v1/health` from your LAN. It should
answer `"status":"ok"`, `"apiVersion":1`.

## 4. Route a hostname through the tunnel

Cloudflare dashboard → **Zero Trust** → **Networks** → **Tunnels** →
`<<your tunnel>>` → **Public hostnames** → **Add**:

- Hostname: `<<garage-test>>.chadwickserver.com`
- Service: `HTTP` → `<<unraid LAN IP>>:<<port>>`

## 5. Create the service token and the Access policy

1. **Zero Trust** → **Access** → **Service credentials** → **Service
   Tokens** → **Create**. Name it `smart-garage-android` and pick a
   duration (non-expiring, or 1 year with a reminder to rotate it). **Copy
   the Client Secret now.** Cloudflare shows it only once. Keep it in your
   password manager; the app stores it in Android Keystore-backed storage.
2. **Access** → **Applications** → **Add** → **Self-hosted**:
   - Domain: `<<garage-test>>.chadwickserver.com`
   - Policy: name `app service token`, **Action: Service Auth**, Include →
     **Service Token** → `smart-garage-android`.

   The action must be **Service Auth**, not *Allow*. Allow expects a person
   to sign in, so the app would be sent to a login page instead.

For production later (CP13): add the same Service Auth policy **next to**
the existing policy on `garage.chadwickserver.com`. Your browser keeps its
login and the app uses the token.

## 6. Run the three checks

From any machine with `curl`, in this repo:

```sh
SG_BASE_URL=https://<<garage-test>>.chadwickserver.com \
CF_ACCESS_CLIENT_ID=<<client id>>.access \
CF_ACCESS_CLIENT_SECRET=<<client secret>> \
SG_USERNAME=<<your username>> SG_PASSWORD=<<your password>> \
scripts/tunnel-check.sh
```

Expected:

```
  ok   1. no CF headers -> 403 from Cloudflare        (or 302)
  ok   2. CF headers + bad bearer -> 401 from Smart Garage
  ok   3. CF headers + real bearer -> 200 (<<username>>)
[tunnel-check] all checks passed
```

To leave the shell history clean, put a space before the command (zsh/bash
with `HIST_IGNORE_SPACE`) or `export` the secrets from your password manager
first.

Optionally run the full endpoint sweep through the tunnel too. This is the
test copy, so writes are fine:

```sh
SG_BASE_URL=… CF_ACCESS_CLIENT_ID=… CF_ACCESS_CLIENT_SECRET=… \
SG_USERNAME=… SG_PASSWORD=… SG_SMOKE_WRITES=1 scripts/api-smoke.sh
```

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Check 1 gets 200 | The Access application doesn't cover the hostname, or it covers a different path. |
| Check 2 gets 403/302 | The service token isn't in the policy, or the action is *Allow* instead of *Service Auth*. |
| An HTML page with "challenge" | Bot Fight Mode or a WAF rule is challenging API calls; add a skip rule for this hostname. |
| 502 / error 1033 | The tunnel can't reach `<<unraid LAN IP>>:<<port>>`, or `cloudflared` is down. |
| Login 429 | The login rate limit (5 failures per 15 min). Wait, or restart the test container. |

Keep the test container until the app is released (CP13), then remove it
together with its appdata copy and public hostname.
