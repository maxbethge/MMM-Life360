/* global Module, Log, L */

/**
 * MMM-Life360
 * A MagicMirror² module that displays the location of all Life360 family
 * members on a map and/or a list, refreshing on a configurable schedule.
 *
 * All sizing (module, map, font) is configurable.
 *
 * Security note: every value that originates from the Life360 API (names,
 * addresses, place names, etc.) is inserted into the DOM via textContent —
 * never innerHTML — to avoid any possibility of markup injection / XSS.
 *
 * License: MIT
 */
Module.register("MMM-Life360", {
  // The canonical module name, used for all client-side logging.
  name: "MMM-Life360",

  defaults: {
    // --- Authentication -----------------------------------------------------
    // Provide either email + password, OR a pre-obtained accessToken.
    email: "",
    password: "",
    accessToken: "",
    // The Life360 client "Basic" auth token used to exchange credentials for
    // an access token. This is the long-standing community client token.
    // Override it here if Life360 changes it.
    authToken:
      "cSgLxOgW7Jm7AbNa16Ki7lhCUcUhCz2Uv6EWt66zBrIZ0Wz7DKZ0lStY1vAP1nA7EObZ8i",

    // User-Agent sent on every request so it looks like the official mobile
    // app. Bump the version if the shared token starts getting blocked.
    userAgent: "com.life360.android.safetymapd/KOKO/23.49.0 android/13",

    // API host. "https://api.life360.com" is what the community library that
    // reliably works uses; "https://api-cloudfront.life360.com" is the more
    // fingerprint-guarded alternative. If one host 403s, try the other — run
    // `node diagnose.js` to see which host+transport actually gets through.
    baseUrl: "", // "" = https://api.life360.com

    // TLS impersonation. Life360 sits behind Cloudflare, which fingerprints
    // the TLS handshake (JA3/JA4) and returns 403 to Node's built-in fetch and
    // curl regardless of headers/IP. When true (default) requests are routed
    // through cycletls with a browser-like fingerprint. Set false to force
    // native fetch. `ja3` overrides the fingerprint if this one gets blocked.
    useImpersonation: true,
    ja3: "", // "" = use the built-in modern-Chrome JA3

    // Token caching: persist a working token to disk so the module reuses it
    // across restarts instead of logging in every time (repeated logins are
    // what trigger Life360's 403s). Life360 issues no refresh token, so the
    // only way to renew is a fresh password login — done automatically on a
    // 401 when email + password are configured.
    cacheToken: true, // set false to never write a token cache file
    tokenCachePath: "", // "" = <module dir>/.life360-token.json

    // Restrict to a single circle by id. Empty = every circle you belong to.
    circleId: "",

    // --- Refresh schedule ---------------------------------------------------
    updateInterval: 60 * 1000, // how often to poll Life360 (ms)
    retryDelay: 15 * 1000, // wait before retrying after a failure (ms)
    animationSpeed: 1000, // DOM fade animation (ms)

    // --- Sizing (all configurable) ------------------------------------------
    moduleWidth: "400px", // overall module width
    moduleHeight: "auto", // overall module height
    mapWidth: "400px", // map width
    mapHeight: "300px", // map height
    fontSize: "16px", // base font size for the module
    listFontSize: "", // font size for the member list ("" = inherit fontSize)
    compactList: false, // tighter rows: single line per member, less padding

    // --- Feature toggles ----------------------------------------------------
    showMap: true,
    showList: true,
    showAddress: true,
    showBattery: true,
    showLastSeen: true,
    showHeader: true,
    interactiveMap: false, // allow dragging/zooming (usually off on a mirror)

    // --- Map appearance -----------------------------------------------------
    mapZoom: 13, // zoom used when only one member is shown
    maxZoom: 16, // cap auto-zoom when fitting everyone (lower = more zoomed out)
    mapTileUrl: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    mapAttribution: "&copy; OpenStreetMap contributors",

    // --- Misc ---------------------------------------------------------------
    maxMembers: 0, // 0 = show everyone
    dateFormat: "HH:mm" // reserved for future use
  },

  requiresVersion: "2.1.0",

  getStyles() {
    return [
      "MMM-Life360.css",
      "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
    ];
  },

  getScripts() {
    return ["https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"];
  },

  start() {
    Log.info(`[${this.name}] starting module`);

    this.members = [];
    this.loaded = false;
    this.errorMessage = null;
    this.map = null;
    this.markerLayer = null;
    this.mapContainer = null;
    this.lastBounds = []; // remembered marker coords, for re-fitting on resume
    this.suspended = false; // set by MagicMirror when another scene is shown

    // Kick off the first fetch and start the configurable refresh loop.
    this.sendConfig();
    this.scheduleUpdate();
  },

  /**
   * MagicMirror lifecycle: called when this module is hidden (e.g. MMM-Scenes2
   * switches to another scene). A hidden Leaflet container has zero size, so we
   * just note that we're suspended and skip map work until we're shown again.
   */
  suspend() {
    this.suspended = true;
    Log.info(`[${this.name}] suspended (hidden)`);
  },

  /**
   * MagicMirror lifecycle: called when this module becomes visible again. The
   * map container was display:none while hidden, so Leaflet's cached size is
   * stale/zero. Re-measure and re-fit once the container has had a moment to lay
   * out — a few staggered attempts cover slow scene transitions/animations.
   */
  resume() {
    this.suspended = false;
    Log.info(`[${this.name}] resumed (visible) — re-measuring map`);
    if (!this.config.showMap) {
      return;
    }
    [50, 300, 800].forEach((delay) => {
      setTimeout(() => this.applyMapView(), delay);
    });
  },

  /** Send the config to the node_helper and request a fetch. */
  sendConfig() {
    Log.info(`[${this.name}] requesting Life360 data`);
    this.sendSocketNotification("LIFE360_FETCH", this.config);
  },

  /** Repeatedly poll Life360 on the configured interval. */
  scheduleUpdate() {
    const interval = Math.max(10 * 1000, this.config.updateInterval);
    Log.info(`[${this.name}] scheduling refresh every ${interval} ms`);
    setInterval(() => {
      this.sendConfig();
    }, interval);
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "LIFE360_DATA") {
      Log.info(
        `[${this.name}] received data for ${payload.members.length} member(s)`
      );
      this.members = payload.members || [];
      this.errorMessage = null;
      this.loaded = true;
      this.updateDom(this.config.animationSpeed);
      // Give the DOM a tick to attach before (re)drawing the map. renderMap()
      // and applyMapView() both no-op safely if we're suspended/zero-sized;
      // resume() re-fits when the scene brings us back.
      setTimeout(() => this.renderMap(), 150);
    } else if (notification === "LIFE360_ERROR") {
      Log.error(`[${this.name}] error: ${payload.message}`);
      this.errorMessage = payload.message;
      this.loaded = true;
      this.updateDom(this.config.animationSpeed);
    }
  },

  getDom() {
    const wrapper = document.createElement("div");
    wrapper.className = "mmm-life360";
    wrapper.style.width = this.config.moduleWidth;
    wrapper.style.height = this.config.moduleHeight;
    wrapper.style.fontSize = this.config.fontSize;

    if (!this.loaded) {
      wrapper.classList.add("mmm-life360-status");
      wrapper.textContent = "Loading Life360…";
      return wrapper;
    }

    if (this.errorMessage) {
      wrapper.classList.add("mmm-life360-status", "mmm-life360-error");
      // errorMessage may echo server-provided text; use textContent (no HTML).
      wrapper.textContent = `Life360: ${this.errorMessage}`;
      return wrapper;
    }

    if (this.config.showHeader) {
      const header = document.createElement("div");
      header.className = "mmm-life360-header";
      header.textContent = "Family";
      wrapper.appendChild(header);
    }

    // --- Map ----------------------------------------------------------------
    if (this.config.showMap) {
      // Reuse the same map container node across renders so Leaflet's state
      // (tiles, markers) survives DOM updates.
      if (!this.mapContainer) {
        this.mapContainer = document.createElement("div");
        this.mapContainer.className = "mmm-life360-map";
      }
      this.mapContainer.style.width = this.config.mapWidth;
      this.mapContainer.style.height = this.config.mapHeight;
      wrapper.appendChild(this.mapContainer);
    }

    // --- List ---------------------------------------------------------------
    if (this.config.showList) {
      const list = document.createElement("ul");
      list.className = "mmm-life360-list";
      if (this.config.compactList) {
        list.classList.add("mmm-life360-list-compact");
      }
      // Optional independent list font size (falls back to the module font).
      if (this.config.listFontSize) {
        list.style.fontSize = this.config.listFontSize;
      }

      const members = this.limitedMembers();
      if (members.length === 0) {
        const empty = document.createElement("li");
        empty.className = "mmm-life360-empty";
        empty.textContent = "No family members found.";
        list.appendChild(empty);
      }

      members.forEach((member, index) => {
        list.appendChild(this.buildMemberRow(member, index));
      });

      wrapper.appendChild(list);
    }

    return wrapper;
  },

  /** Build one list row for a member. All member text uses textContent. */
  buildMemberRow(member, index) {
    const row = document.createElement("li");
    row.className = "mmm-life360-member";

    const dot = document.createElement("span");
    dot.className = "mmm-life360-dot";
    dot.style.backgroundColor = this.colorFor(index);
    row.appendChild(dot);

    const info = document.createElement("div");
    info.className = "mmm-life360-info";

    const nameEl = document.createElement("span");
    nameEl.className = "mmm-life360-name";
    nameEl.textContent = member.name || "Unknown";
    info.appendChild(nameEl);

    if (this.config.showAddress) {
      const place = member.placeName || member.address || "Location unknown";
      const placeEl = document.createElement("span");
      placeEl.className = "mmm-life360-place";
      placeEl.textContent = place;
      info.appendChild(placeEl);
    }

    const meta = document.createElement("span");
    meta.className = "mmm-life360-meta";
    const metaParts = [];

    if (this.config.showBattery && member.battery !== null) {
      const charging = member.isCharging ? " ⚡" : "";
      metaParts.push(`🔋 ${member.battery}%${charging}`);
    }
    if (member.isDriving) {
      metaParts.push("🚗 driving");
    }
    if (this.config.showLastSeen && member.timestamp) {
      metaParts.push(this.relativeTime(member.timestamp));
    }
    meta.textContent = metaParts.join(" · ");
    info.appendChild(meta);

    row.appendChild(info);
    return row;
  },

  /** Draw / update the Leaflet map. Retries until Leaflet has loaded. */
  renderMap() {
    if (!this.config.showMap || !this.mapContainer) {
      return;
    }
    if (typeof L === "undefined") {
      // Leaflet script not ready yet; try again shortly.
      Log.info(`[${this.name}] waiting for Leaflet to load`);
      setTimeout(() => this.renderMap(), 250);
      return;
    }

    // Keep each member's index within the full member list so a pin's colour
    // matches that member's list dot (colorFor is index-based). Filtering would
    // renumber them and desync the two.
    const points = [];
    (this.members || []).forEach((member, index) => {
      if (
        Number.isFinite(member.latitude) &&
        Number.isFinite(member.longitude)
      ) {
        points.push({ member, index });
      }
    });

    // Distinguish "no members" from "members without coordinates" so a blank
    // map is easy to diagnose from the logs.
    const total = (this.members || []).length;
    Log.info(
      `[${this.name}] rendering map: ${points.length}/${total} member(s) have coordinates`
    );
    if (total > 0 && points.length === 0) {
      Log.warn(
        `[${this.name}] no members have coordinates — location sharing may be ` +
          "off for everyone, so there are no pins to place"
      );
    }

    try {
      if (!this.map) {
        this.map = L.map(this.mapContainer, {
          zoomControl: this.config.interactiveMap,
          attributionControl: true,
          dragging: this.config.interactiveMap,
          scrollWheelZoom: this.config.interactiveMap,
          doubleClickZoom: this.config.interactiveMap,
          boxZoom: this.config.interactiveMap,
          keyboard: this.config.interactiveMap,
          tap: this.config.interactiveMap
        }).setView([0, 0], this.config.mapZoom);

        L.tileLayer(this.config.mapTileUrl, {
          attribution: this.config.mapAttribution,
          maxZoom: 19
        }).addTo(this.map);

        this.markerLayer = L.layerGroup().addTo(this.map);
      }

      this.markerLayer.clearLayers();

      // Members sharing (almost) the same coordinates would otherwise stack and
      // hide each other. Group them by a rounded lat/long key (~11 m) and draw a
      // single combined marker per spot.
      const groups = this.groupByLocation(points);

      const bounds = [];
      groups.forEach((group) => {
        const first = group[0].member;
        const marker =
          group.length === 1
            ? this.buildSinglePin(group[0])
            : this.buildClusterPin(group);
        marker.addTo(this.markerLayer);
        bounds.push([first.latitude, first.longitude]);
      });

      // Remember the marker coordinates so resume()/suspend transitions can
      // re-fit the view without re-fetching data.
      this.lastBounds = bounds;

      // Position the view. CRITICAL: invalidateSize() must run BEFORE fitBounds
      // /setView — the map container is (re)attached to the DOM on every
      // updateDom, and until Leaflet re-measures it, fitBounds computes zoom
      // against a stale/zero size and drops the pins off-screen (map shows, no
      // pins). We re-apply once after paint to catch the first render where the
      // container hadn't been laid out yet.
      this.applyMapView();
      setTimeout(() => this.applyMapView(), 300);
    } catch (err) {
      Log.error(`[${this.name}] failed to render map: ${err.message}`);
    }
  },

  /**
   * Re-measure the map and fit the view to the last known marker bounds. Safe
   * to call any time the module is visible — used both after a data refresh and
   * on resume() when a scene switch brings the module back. Skips work while the
   * container is hidden/zero-sized (calling invalidateSize then is what leaves
   * the map mis-rendered when it reappears).
   */
  applyMapView() {
    if (!this.map || this.suspended) {
      return;
    }
    const el = this.mapContainer;
    // A hidden (display:none) or not-yet-laid-out container reports zero size;
    // fitting against that is exactly what breaks the map. Bail and let a later
    // resume()/render retry once it has real dimensions.
    if (!el || el.offsetWidth === 0 || el.offsetHeight === 0) {
      return;
    }

    this.map.invalidateSize();
    const bounds = this.lastBounds || [];
    if (bounds.length === 1) {
      this.map.setView(bounds[0], this.config.mapZoom);
    } else if (bounds.length > 1) {
      this.map.fitBounds(bounds, {
        padding: [30, 30],
        maxZoom: this.config.maxZoom
      });
    }
  },

  /**
   * Group located members that share (almost) the same spot so co-located
   * people don't stack invisibly on top of each other. Rounds lat/long to
   * ~4 decimal places (≈11 m) and buckets by that key, preserving list order
   * (and therefore colour order) within each group.
   */
  groupByLocation(points) {
    const buckets = new Map();
    const order = [];
    points.forEach((point) => {
      const { member } = point;
      const key = `${member.latitude.toFixed(4)},${member.longitude.toFixed(4)}`;
      if (!buckets.has(key)) {
        buckets.set(key, []);
        order.push(key);
      }
      buckets.get(key).push(point);
    });
    return order.map((key) => buckets.get(key));
  },

  /** Build a normal teardrop pin for a single member at a location. */
  buildSinglePin(point) {
    const { member, index } = point;
    const color = this.colorFor(index);
    const initial = (member.name || "?").trim().charAt(0).toUpperCase();

    // Build the pin as a DOM node so the (member-derived) initial is set via
    // textContent, never interpolated into an HTML string.
    const pin = document.createElement("div");
    pin.className = "mmm-life360-pin";
    pin.style.background = color;
    pin.textContent = initial;

    const icon = L.divIcon({
      className: "mmm-life360-marker",
      html: pin, // Leaflet accepts an HTMLElement here
      // Keep in sync with .mmm-life360-pin in the CSS (20×20; anchor = half).
      iconSize: [20, 20],
      iconAnchor: [10, 10]
    });

    return L.marker([member.latitude, member.longitude], { icon }).bindPopup(
      this.buildGroupPopup(point ? [point] : [])
    );
  },

  /**
   * Build a combined "pie" badge for multiple members at one spot: a round
   * marker split into equal colored wedges (one per member, matching their list
   * dot colour) with the member count in the centre. Uses an SVG conic-style
   * pie so the individual colours are all visible at a glance.
   */
  buildClusterPin(group) {
    const size = 30; // px — a touch larger than a single pin so the count fits
    const r = size / 2;
    const count = group.length;

    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
    svg.classList.add("mmm-life360-cluster-svg");

    // One wedge per member. A single full circle (count === 1) never reaches
    // here, so every group has >= 2 slices.
    const sliceAngle = (2 * Math.PI) / count;
    group.forEach((point, i) => {
      // Start at the top (−90°) and go clockwise.
      const start = -Math.PI / 2 + i * sliceAngle;
      const end = start + sliceAngle;
      const x1 = r + r * Math.cos(start);
      const y1 = r + r * Math.sin(start);
      const x2 = r + r * Math.cos(end);
      const y2 = r + r * Math.sin(end);
      const largeArc = sliceAngle > Math.PI ? 1 : 0;

      const path = document.createElementNS(NS, "path");
      path.setAttribute(
        "d",
        `M ${r} ${r} L ${x1.toFixed(3)} ${y1.toFixed(3)} ` +
          `A ${r} ${r} 0 ${largeArc} 1 ${x2.toFixed(3)} ${y2.toFixed(3)} Z`
      );
      path.setAttribute("fill", this.colorFor(point.index));
      svg.appendChild(path);
    });

    // Centre disc + count so the number stays legible over the wedges.
    const disc = document.createElementNS(NS, "circle");
    disc.setAttribute("cx", String(r));
    disc.setAttribute("cy", String(r));
    disc.setAttribute("r", String(r * 0.55));
    disc.setAttribute("class", "mmm-life360-cluster-center");
    svg.appendChild(disc);

    const label = document.createElementNS(NS, "text");
    label.setAttribute("x", String(r));
    label.setAttribute("y", String(r));
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("dominant-baseline", "central");
    label.setAttribute("class", "mmm-life360-cluster-count");
    label.textContent = String(count); // count is a number — safe

    svg.appendChild(label);

    const wrap = document.createElement("div");
    wrap.className = "mmm-life360-cluster";
    wrap.appendChild(svg);

    const icon = L.divIcon({
      className: "mmm-life360-marker",
      html: wrap,
      iconSize: [size, size],
      iconAnchor: [r, r]
    });

    const first = group[0].member;
    return L.marker([first.latitude, first.longitude], { icon }).bindPopup(
      this.buildGroupPopup(group)
    );
  },

  /**
   * Popup listing everyone at a location, each with a colour swatch matching
   * their pin/list colour. Built with DOM + textContent (no HTML strings) so
   * member-derived text can never inject markup.
   */
  buildGroupPopup(group) {
    const popup = document.createElement("div");
    popup.className = "mmm-life360-popup";

    // Shared place/address (all members in a group are at the same spot).
    const detail =
      (group[0] &&
        (group[0].member.placeName || group[0].member.address)) ||
      "";
    if (detail && group.length > 1) {
      const place = document.createElement("div");
      place.className = "mmm-life360-popup-place";
      place.textContent = detail;
      popup.appendChild(place);
    }

    group.forEach((point) => {
      const { member } = point;
      const row = document.createElement("div");
      row.className = "mmm-life360-popup-row";

      const swatch = document.createElement("span");
      swatch.className = "mmm-life360-popup-swatch";
      swatch.style.backgroundColor = this.colorFor(point.index);
      row.appendChild(swatch);

      const nameEl = document.createElement("b");
      nameEl.textContent = member.name || "Unknown";
      row.appendChild(nameEl);

      // For a single-member popup, keep the place on its own line as before.
      if (group.length === 1) {
        const only = member.placeName || member.address || "";
        if (only) {
          const br = document.createElement("br");
          row.appendChild(br);
          const detailEl = document.createElement("span");
          detailEl.textContent = only;
          row.appendChild(detailEl);
        }
      }

      popup.appendChild(row);
    });

    return popup;
  },

  /** Return members trimmed to config.maxMembers (0 = all). */
  limitedMembers() {
    if (this.config.maxMembers && this.config.maxMembers > 0) {
      return this.members.slice(0, this.config.maxMembers);
    }
    return this.members;
  },

  /** Deterministic colour per member index. */
  colorFor(index) {
    const palette = [
      "#e6194B",
      "#3cb44b",
      "#4363d8",
      "#f58231",
      "#911eb4",
      "#42d4f4",
      "#f032e6",
      "#bfef45",
      "#fabed4",
      "#469990"
    ];
    return palette[index % palette.length];
  },

  /** Human-friendly "x minutes ago" from a unix timestamp (seconds). */
  relativeTime(timestampSeconds) {
    const then = Number(timestampSeconds) * 1000;
    if (!Number.isFinite(then) || then <= 0) {
      return "";
    }
    const diff = Math.max(0, Date.now() - then);
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }
});
