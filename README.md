# MMM-Life360

A [MagicMirror²](https://magicmirror.builders/) module that shows the location
of all your [Life360](https://www.life360.com/) family members on a map and in a
list. It refreshes on a configurable schedule, and the module size, map size and
font size are all configurable.

## Preview

> The image below is an illustrative mockup showing the module's layout,
> colours and styling — not a live screenshot. Your real map tiles, family
> members and locations will differ.

<p align="center">
  <img src="preview.svg" alt="MMM-Life360 preview: a map with coloured pins for each family member above a list showing name, place, battery and last-seen time" width="440">
</p>

```
┌─────────────────────────────┐
│ FAMILY                      │   ← optional header
│ ┌─────────────────────────┐ │
│ │                         │ │
│ │      🅐   🅑           │ │   ← Leaflet map, one coloured
│ │   🅒        🅓        │ │     pin per family member
│ │                         │ │     (size set by mapWidth/mapHeight)
│ └─────────────────────────┘ │
│ ● Alex                      │
│   Home                      │   ← list rows: name, place/address,
│   🔋 82% ⚡ · 3m ago        │     battery, driving, last-seen
│ ● Bailey                    │
│   Lincoln High School       │
│   🔋 47% · 12m ago          │
│ ● Casey                     │
│   120 Main St               │
│   🔋 63% · 🚗 driving · now │
└─────────────────────────────┘
   width = moduleWidth · text = fontSize
```

## Features

- 🗺️ Interactive-optional Leaflet map with a coloured pin per family member
- 📋 List view with name, current place/address, battery level and "last seen"
- 🔄 Configurable refresh schedule
- 📐 Configurable module size, map size and font size
- 🔐 Log in with email/password, or supply a pre-obtained access token
- 🛡️ Defeats Life360's Cloudflare TLS-fingerprint (JA3) `403`s via `cycletls`
- 💾 Caches the access token to disk and re-logs-in automatically on expiry
- 🛠️ Bundled `get-token.js` helper to grab a token when logins are blocked
- 🪵 All log lines are prefixed with the module name (`[MMM-Life360]`) on both
  the browser and server side

## Requirements

- MagicMirror² `>= 2.1.0`
- Node.js `>= 18`
- A Life360 account

## Installation

```bash
cd ~/MagicMirror/modules
git clone https://github.com/maxbethge/MMM-Life360
cd MMM-Life360
npm install        # installs cycletls — see "Cloudflare TLS fingerprinting"
```

**Run `npm install`** — it is not optional. It installs [`cycletls`](https://github.com/Danny-Dasilva/CycleTLS),
which lets the module present a browser-like TLS fingerprint. Without it,
Life360's Cloudflare frontend will very likely reject requests with **HTTP 403**
(see [Cloudflare TLS fingerprinting](#cloudflare-tls-fingerprinting-important)).
`cycletls` ships prebuilt Go binaries for Linux (x64 / **arm64 / armv7**, so
Raspberry Pi works), macOS and Windows.

Leaflet (used for the map) is loaded automatically from a CDN, so an internet
connection is required for the map tiles.

## Known-good configuration (2FA / email-code accounts)

If your account signs in with an emailed code (no password), this is the setup
confirmed to work — a token captured from the app, served over cycletls:

```js
config: {
  accessToken: "PASTE_CAPTURED_TOKEN",       // from the app (README Option B)
  baseUrl: "https://api-cloudfront.life360.com",
  useImpersonation: true,                    // cycletls TLS fingerprint
  updateInterval: 60 * 1000
  // no email/password: this account type can't password-login
}
```

Verify any token end-to-end first with `node diagnose.js --token`. Two gotchas
worth knowing:

- **`fetch` is blocked; cycletls works.** Data requests over native `fetch` get
  a Cloudflare `403`; only the cycletls transport gets through. Keep
  `useImpersonation: true`.
- **Brotli → empty bodies.** cycletls doesn't decode Cloudflare's default Brotli
  compression, which shows up as an HTTP `200` with an *empty body*. The module
  sends `Accept-Encoding: gzip, deflate` to avoid this; don't override it.

## Configuration

Add the module to the `modules` array in `~/MagicMirror/config/config.js`:

```js
{
  module: "MMM-Life360",
  position: "top_right",
  config: {
    // --- Authentication (choose ONE) ---
    email: "you@example.com",
    password: "your-life360-password",
    // accessToken: "eyJ...",   // alternative to email/password

    // --- Refresh schedule ---
    updateInterval: 60 * 1000,  // poll every 60 seconds

    // --- Sizing ---
    moduleWidth: "420px",
    moduleHeight: "auto",
    mapWidth: "420px",
    mapHeight: "320px",
    fontSize: "16px",

    // --- Features ---
    showMap: true,
    showList: true,
    showAddress: true,
    showBattery: true,
    showLastSeen: true
  }
}
```

### All configuration options

| Option           | Type    | Default                                | Description |
|------------------|---------|----------------------------------------|-------------|
| `email`          | string  | `""`                                   | Life360 account email. |
| `password`       | string  | `""`                                   | Life360 account password. |
| `accessToken`    | string  | `""`                                   | Pre-obtained bearer token. Use instead of email/password. See [Getting an access token](#getting-an-access-token). |
| `authToken`      | string  | community client token                 | The Basic auth client token used to exchange credentials for an access token. Override if Life360 changes it. |
| `baseUrl`        | string  | `""`                                   | API host. `""` = `https://api.life360.com`. Try `https://api-cloudfront.life360.com` if that host 403s. |
| `userAgent`      | string  | Android app UA                         | `User-Agent` sent on every request so it looks like the official mobile app. Bump the version if the shared token gets blocked. |
| `useImpersonation` | boolean | `true`                               | Route requests through `cycletls` with a browser TLS fingerprint to defeat Cloudflare's JA3/JA4 blocking. Set `false` to force native `fetch` (likely 403s). |
| `ja3`            | string  | `""`                                   | Override the TLS fingerprint (JA3 string). `""` = built-in modern-Chrome JA3. Change if the default gets blocked. |
| `cacheToken`     | boolean | `true`                                 | Persist a working token to disk and reuse it across restarts (fewer logins = fewer 403s). |
| `tokenCachePath` | string  | `""`                                   | Where to store the cached token. `""` = `<module dir>/.life360-token.json`. |
| `circleId`       | string  | `""`                                   | Restrict to a single circle. Empty = all circles you belong to. |
| `updateInterval` | number  | `60000`                                | Refresh interval in ms (minimum 10 s enforced). |
| `retryDelay`     | number  | `15000`                                | Reserved for retry backoff (ms). |
| `animationSpeed` | number  | `1000`                                 | DOM fade animation duration (ms). |
| `moduleWidth`    | string  | `"400px"`                              | Overall module width (any CSS size). |
| `moduleHeight`   | string  | `"auto"`                               | Overall module height. |
| `mapWidth`       | string  | `"400px"`                              | Map width. |
| `mapHeight`      | string  | `"300px"`                              | Map height. |
| `fontSize`       | string  | `"16px"`                               | Base font size for the list. |
| `showMap`        | boolean | `true`                                 | Show the Leaflet map. |
| `showList`       | boolean | `true`                                 | Show the member list. |
| `showAddress`    | boolean | `true`                                 | Show place/address in the list. |
| `showBattery`    | boolean | `true`                                 | Show battery level in the list. |
| `showLastSeen`   | boolean | `true`                                 | Show a "last seen" relative time. |
| `showHeader`     | boolean | `true`                                 | Show the "Family" header. |
| `interactiveMap` | boolean | `false`                                | Allow dragging/zooming the map. |
| `mapZoom`        | number  | `13`                                   | Zoom level when a single member is shown. |
| `mapTileUrl`     | string  | OpenStreetMap tiles                    | Leaflet tile URL template. |
| `mapAttribution` | string  | OSM attribution                        | Map attribution text. |
| `maxMembers`     | number  | `0`                                    | Limit the number of members shown (0 = all). |

## Cloudflare TLS fingerprinting (important)

The single most common reason people can't talk to the Life360 API — from
**any** tool — is a **persistent `403 Forbidden` from Cloudflare** that has
nothing to do with your credentials, headers, payload, or IP address.

Life360's API is fronted by Cloudflare, which **fingerprints the TLS
handshake** (JA3 / JA4). Requests made with Node's built-in `fetch`/undici, and
with plain `curl`, present a fingerprint Cloudflare frequently blocks —
*regardless* of a valid `User-Agent`, auth token or residential IP. Requests
that use a browser-like TLS stack (or OpenSSL, as some client libraries do) are
allowed through. This is documented in the community:

- [`pnbruckner/life360` #22 — "403 Errors - Caused by handshake fingerprinting"](https://github.com/pnbruckner/life360/issues/22)
  (the original report; note the maintainer did not technically confirm it)
- [`pnbruckner/ha-life360` #84](https://github.com/pnbruckner/ha-life360/issues/84)
  — a **valid bearer token** still got `403` on the `/circles` *data* endpoint,
  showing the block is not limited to login
- [`pnbruckner/ha-life360` #99](https://github.com/pnbruckner/ha-life360/pull/99)
  — a merged fix proving Cloudflare gates on TLS/ALPN characteristics

**How this module deals with it:** by default (`useImpersonation: true`) every
request — both login *and* data calls — is routed through
[`cycletls`](https://github.com/Danny-Dasilva/CycleTLS), which performs the TLS
handshake with a configurable browser fingerprint (a modern Chrome JA3 by
default). This is why `npm install` is required.

- If `cycletls` isn't installed or its binary can't start, the module logs a
  warning and **falls back to native `fetch`** — it will still work if Cloudflare
  happens to accept your fetch fingerprint, but many setups will see `403`.
- If Cloudflare starts blocking the built-in JA3, set a different one via the
  `ja3` config option.
- You can force `fetch`-only behaviour with `useImpersonation: false` (expect
  `403`s on most setups — this is confirmed for real accounts).

**Brotli / empty-body caveat.** cycletls does not decode Cloudflare's default
Brotli (`br`) compression, which surfaces as an HTTP `200` with an *empty body*
— a silent "success" with no data. The module requests
`Accept-Encoding: gzip, deflate` on every call to avoid this; leave that header
alone. `diagnose.js` explicitly flags a decoded-but-empty 200 rather than
reporting a false ✅.

> **Honesty note:** the JA3/JA4 explanation is well-supported but not officially
> confirmed by Life360 (there is no official API). If impersonation stops
> working, capturing a token from the app
> ([Option B](#option-b--capture-a-token-from-the-real-app-most-reliable-required-for-otp-accounts))
> is the fallback that always works.

## How authentication works

On each refresh the server-side helper (`node_helper.js`) makes sure it has a
usable token, preferring cheap sources first:

1. **In-memory token** from this session, if any.
2. **Cached token** on disk (`.life360-token.json`), if `cacheToken` is on.
3. **`accessToken`** from config, if provided.
4. Otherwise **log in** by exchanging your `email` + `password` for a token via
   Life360's OAuth token endpoint, then cache the result.

It then fetches your circles (filtered by `circleId` if set), fetches the
members with locations for each, merges them, and sends a normalised list to the
browser module.

### Token lifetime & "refresh"

**Life360 does not issue a refresh token.** Its `password` grant returns only an
`access_token` — there is no `refresh_token` and no `expires_in` field. The
token is **long-lived**: it stays valid until it is revoked server-side (e.g. you
log out elsewhere or Life360 invalidates it). There is therefore no lightweight
background "refresh" possible — the *only* way to obtain a new token is to log in
again with the password.

The module handles this as gracefully as the API allows:

- **Token caching** (on by default) writes a working token to
  `.life360-token.json` (mode `600`) so restarts reuse it instead of logging in
  again. Fewer logins means far fewer Cloudflare `403`s.
- **Auto re-login on 401.** If a request comes back `401` (token rejected), the
  module discards the token and, **if `email` + `password` are configured**, logs
  in again automatically and retries — all in the background.
- **Token-only setups** (no credentials) can't self-heal, because there's
  nothing to log in with. When such a token is finally revoked, the module stops
  retrying it and shows a clear message telling you to supply a fresh
  `accessToken` (or add credentials). Grab a new one as below.

> **Note:** Life360 has no official public API. This module uses the
> long-standing community client token. If Life360 changes it and login starts
> failing, either update the `authToken` / `userAgent` options or supply an
> `accessToken` directly.

## Getting an access token

> ### ⚠️ Passwordless / email-code (OTP) accounts — read this first
>
> If signing in to Life360 **emails you a 6-digit code instead of asking for a
> password**, your account has no password to send, so the automated
> `email + password` login (Option A) and `get-token.js` **cannot work for you at
> all** — regardless of Cloudflare. This is common on newer/2FA-enabled accounts.
>
> **Your only route is Option B: capture a token from the app.** Then verify it
> with `node diagnose.js --token` and put it in `accessToken` (leave
> `email`/`password` unset). Because there's no password login, the module can't
> auto-refresh — you'll re-capture when the token is revoked.

For password accounts, work through these in order. The bundled helper uses the
same TLS impersonation as the module, so it's the most likely to succeed.

> A `403` here is almost always [Cloudflare TLS fingerprinting](#cloudflare-tls-fingerprinting-important),
> **not** your IP or credentials. Moving to a "residential" connection does *not*
> help — the TLS stack is what matters.

### Option A — the bundled helper script (password accounts only)

From the module folder (after `npm install`, so `cycletls` is available):

```bash
node get-token.js
# or:  node get-token.js you@example.com
# or non-interactively:
LIFE360_EMAIL="you@example.com" LIFE360_PASSWORD="secret" node get-token.js
```

The helper tries `cycletls` first and falls back to `fetch`, logging which
transport it used. It prints an access token — copy it into your config:

```js
config: {
  accessToken: "PASTE_THE_TOKEN_HERE",
  updateInterval: 60 * 1000
}
```

Add `--save` to also write the token straight into the module's cache file, so
the module picks it up with no config edit:

```bash
node get-token.js --save
```

### Option B — capture a token from the real app (most reliable; required for OTP accounts)

The Life360 app on your phone has already completed login (including any emailed
code) and holds a valid bearer token. Lifting that token bypasses **both** the
Cloudflare login gate **and** the passwordless/2FA problem:

1. Put an intercepting proxy in front of your phone — [HTTP Toolkit](https://httptoolkit.com/)
   is the easiest, or use mitmproxy / Charles.
2. Open the Life360 app and let it load your family.
3. Find any request to `api.life360.com` / `api-cloudfront.life360.com`
   (e.g. `/v3/circles`).
4. In its request headers, copy the value after `Authorization: Bearer ` — that
   string is your `accessToken`.

**Verify it before editing config** — this GETs the real data endpoint on both
hosts and both transports and tells you exactly which to use:

```bash
node diagnose.js --token
# or:  LIFE360_TOKEN="eyJ..." node diagnose.js
```

If it reports ✅, apply the `accessToken` / `baseUrl` / `useImpersonation` values
it prints:

```js
config: {
  accessToken: "PASTE_THE_TOKEN_HERE",
  baseUrl: "https://api.life360.com",  // whichever host the test said ✅
  useImpersonation: true,              // true if a cycletls row won, else false
  updateInterval: 60 * 1000
  // NOTE: no email/password — an OTP account can't password-login, and a
  // captured token can't self-refresh. Re-capture when it stops working.
}
```

> A captured token still has to pass Cloudflare on the module's *data* requests
> too — a valid token alone isn't always enough
> ([#84](https://github.com/pnbruckner/ha-life360/issues/84)). The `--token` test
> confirms whether it does on your setup before you commit to it.

### Option C — plain `curl` (usually blocked)

For completeness only. `curl`'s TLS fingerprint is one of the ones Cloudflare
tends to block, so this **often returns `403`** — but it's occasionally useful
for a quick test:

```bash
curl -s -X POST 'https://api-cloudfront.life360.com/v3/oauth2/token' \
  -H 'Authorization: Basic cSgLxOgW7Jm7AbNa16Ki7lhCUcUhCz2Uv6EWt66zBrIZ0Wz7DKZ0lStY1vAP1nA7EObZ8i' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -H 'Accept: application/json' \
  -H 'cache-control: no-cache' \
  -H 'User-Agent: com.life360.android.safetymapd/KOKO/23.49.0 android/13' \
  --data-urlencode 'grant_type=password' \
  --data-urlencode 'username=YOUR_EMAIL' \
  --data-urlencode 'password=YOUR_PASSWORD'
```

If it works, the JSON response contains `"access_token": "…"`. If it `403`s, use
Option A or B. (`curl-impersonate` mimics a browser fingerprint and works where
stock `curl` fails.)

## Logging

Every log line — client and server — is prefixed with `[MMM-Life360]`, so you
can filter the MagicMirror logs easily:

```bash
pm2 logs mm | grep MMM-Life360
```

## Still getting 403s? Run the diagnostic

Don't keep guessing — find out *which* 403 it is. From the module folder:

```bash
node diagnose.js
```

It tries the login across **both API hosts** (`api.life360.com` and
`api-cloudfront.life360.com`) using **both transports** (cycletls and native
fetch) and prints, for each, the status, the `Server` / `cf-ray` /
`cf-mitigated` headers, and a body snippet — then a verdict:

| Verdict | Meaning | What to do |
|---------|---------|------------|
| ✅ **SUCCESS** | That host+transport works | Set `baseUrl` to that host (and keep `useImpersonation: true` if cycletls won). |
| ⛔ **CLOUDFLARE BLOCK** | TLS fingerprint rejected (HTML body, `cf-ray` present) | A token won't help. Try a different `ja3`, or capture a token from the app. |
| 🔑 **LIFE360 REJECTED** | Got *through* Cloudflare; login refused (JSON body) | Check email/password and `authToken`; if the account has 2FA, use app capture. |
| ⏳ **RATE LIMITED** | `429` | Increase `updateInterval` and wait before retrying. |

This instantly tells you whether you have a **TLS problem** (Cloudflare) or a
**credential problem** (Life360) — they need opposite fixes. The module logs the
same diagnosis automatically on every failed request.

The most common fixes, in order:

1. **Switch `baseUrl`** — if the default `https://api.life360.com` 403s, try
   `https://api-cloudfront.life360.com` (or vice-versa). Different hosts, different
   Cloudflare rules.
2. **Confirm cycletls is actually active** — the log should say
   `TLS impersonation enabled (cycletls)`, *not* a fallback-to-fetch warning. If
   it fell back, `npm install` didn't complete for your platform.
3. **Try a different `ja3`** — Cloudflare may have blocked the built-in one.
4. **Capture a token from the app** — bypasses both TLS and 2FA
   ([Option B](#option-b--capture-a-token-from-the-real-app-most-reliable)).

## Troubleshooting

- **`global fetch is unavailable`** — upgrade to Node 18 or newer.
- **`403 Forbidden` (login or data)** — run `node diagnose.js` (above) to tell a
  Cloudflare TLS block apart from a credential rejection. If it's Cloudflare,
  make sure `npm install` ran so `cycletls` is present, try the other `baseUrl`,
  or set a different `ja3`. If it's Life360, check credentials / 2FA.
- **`access token is invalid, expired, or revoked …`** — your `accessToken` was
  revoked and there are no `email` + `password` to refresh it with. Grab a fresh
  token, or add credentials so the module can re-login automatically.
- **Stale data / repeated logins** — make sure `cacheToken` is enabled (default)
  and that `.life360-token.json` is writable by the MagicMirror user.
- **Map is blank** — check the Pi has internet access for the map tiles, or
  point `mapTileUrl` at a reachable tile server.

## License

MIT — see [LICENSE](LICENSE).

## Disclaimer

This project is not affiliated with, endorsed by, or connected to Life360, Inc.
"Life360" is a trademark of its respective owner. Use at your own risk and in
accordance with Life360's terms of service.
