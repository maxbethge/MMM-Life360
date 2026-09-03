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
- 🪵 All log lines are prefixed with the module name (`[MMM-Life360]`) on both
  the browser and server side

## Requirements

- MagicMirror² `>= 2.1.0`
- Node.js `>= 18` (the server-side helper uses the built-in `fetch` API)
- A Life360 account

## Installation

```bash
cd ~/MagicMirror/modules
git clone https://github.com/maxbethge/MMM-Life360
cd MMM-Life360
npm install        # no runtime dependencies, but keeps things tidy
```

Leaflet (used for the map) is loaded automatically from a CDN, so an internet
connection is required for the map tiles.

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
| `accessToken`    | string  | `""`                                   | Pre-obtained bearer token. Use instead of email/password. |
| `authToken`      | string  | community client token                 | The Basic auth client token used to exchange credentials for an access token. Override if Life360 changes it. |
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

## How authentication works

On each refresh the server-side helper (`node_helper.js`):

1. Uses `accessToken` from config if provided; otherwise exchanges your
   `email` + `password` for an access token via Life360's OAuth token endpoint.
2. Fetches the circles on the account (filtered by `circleId` if set).
3. Fetches the members (with locations) for each circle and merges them.
4. Sends a normalised list back to the browser module.

If the token is rejected (HTTP 401) it is discarded and re-requested on the next
tick.

> **Note:** Life360 has no official public API. This module uses the
> long-standing community client token. If Life360 changes it and login starts
> failing, either update the `authToken` option or supply an `accessToken`
> directly.

## Logging

Every log line — client and server — is prefixed with `[MMM-Life360]`, so you
can filter the MagicMirror logs easily:

```bash
pm2 logs mm | grep MMM-Life360
```

## Troubleshooting

- **`global fetch is unavailable`** — upgrade to Node 18 or newer.
- **`authentication failed (403 …)`** — Life360 may be challenging the login;
  try again later or obtain an `accessToken` manually and set it in config.
- **Map is blank** — check the Pi has internet access for the map tiles, or
  point `mapTileUrl` at a reachable tile server.

## License

MIT — see [LICENSE](LICENSE).

## Disclaimer

This project is not affiliated with, endorsed by, or connected to Life360, Inc.
"Life360" is a trademark of its respective owner. Use at your own risk and in
accordance with Life360's terms of service.
