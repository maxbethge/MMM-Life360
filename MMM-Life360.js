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
    fontSize: "16px", // base font size for the member list

    // --- Feature toggles ----------------------------------------------------
    showMap: true,
    showList: true,
    showAddress: true,
    showBattery: true,
    showLastSeen: true,
    showHeader: true,
    interactiveMap: false, // allow dragging/zooming (usually off on a mirror)

    // --- Map appearance -----------------------------------------------------
    mapZoom: 13,
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

    // Kick off the first fetch and start the configurable refresh loop.
    this.sendConfig();
    this.scheduleUpdate();
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
      // Give the DOM a tick to attach before (re)drawing the map.
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

    const points = (this.members || []).filter(
      (m) => Number.isFinite(m.latitude) && Number.isFinite(m.longitude)
    );

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

      const bounds = [];
      points.forEach((member, index) => {
        const color = this.colorFor(index);
        const initial = (member.name || "?").trim().charAt(0).toUpperCase();

        // Build the pin as a DOM node so the (member-derived) initial is set
        // via textContent, never interpolated into an HTML string.
        const pin = document.createElement("div");
        pin.className = "mmm-life360-pin";
        pin.style.background = color;
        pin.textContent = initial;

        const icon = L.divIcon({
          className: "mmm-life360-marker",
          html: pin, // Leaflet accepts an HTMLElement here
          iconSize: [28, 28],
          iconAnchor: [14, 14]
        });

        // Popup content built with DOM + textContent (no HTML strings).
        const popup = document.createElement("div");
        const popupName = document.createElement("b");
        popupName.textContent = member.name || "Unknown";
        popup.appendChild(popupName);
        const detail = member.placeName || member.address || "";
        if (detail) {
          popup.appendChild(document.createElement("br"));
          const detailEl = document.createElement("span");
          detailEl.textContent = detail;
          popup.appendChild(detailEl);
        }

        L.marker([member.latitude, member.longitude], { icon })
          .bindPopup(popup)
          .addTo(this.markerLayer);
        bounds.push([member.latitude, member.longitude]);
      });

      if (bounds.length === 1) {
        this.map.setView(bounds[0], this.config.mapZoom);
      } else if (bounds.length > 1) {
        this.map.fitBounds(bounds, { padding: [25, 25] });
      }

      // Container was just (re)attached to the DOM; recompute tile layout.
      this.map.invalidateSize();
    } catch (err) {
      Log.error(`[${this.name}] failed to render map: ${err.message}`);
    }
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
