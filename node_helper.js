/**
 * MMM-Life360 — node_helper
 *
 * Handles all communication with the Life360 API:
 *   1. Authenticates (email/password -> access token) or uses a supplied token.
 *   2. Fetches the circles you belong to.
 *   3. Fetches the members (with locations) for each circle.
 *   4. Normalises the data and sends it back to the browser module.
 *
 * All log lines are prefixed with the module name.
 *
 * Requires Node 18+ (uses the global fetch API).
 */
const NodeHelper = require("node_helper");

const MODULE_NAME = "MMM-Life360";
const BASE_URL = "https://api-cloudfront.life360.com";

module.exports = NodeHelper.create({
  start() {
    this.accessToken = null;
    this.config = null;
    this.busy = false;
    this.log("node_helper started");
  },

  // --- logging helpers (always include the module name) ---------------------
  log(message) {
    console.log(`[${MODULE_NAME}] ${message}`);
  },
  warn(message) {
    console.warn(`[${MODULE_NAME}] ${message}`);
  },
  error(message) {
    console.error(`[${MODULE_NAME}] ${message}`);
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "LIFE360_FETCH") {
      this.config = payload;
      this.fetchData();
    }
  },

  /** Send a normalised member list back to the module. */
  sendData(members) {
    this.sendSocketNotification("LIFE360_DATA", { members });
  },

  /** Send an error message back to the module. */
  sendError(message) {
    this.error(message);
    this.sendSocketNotification("LIFE360_ERROR", { message });
  },

  /** Guard against overlapping refreshes if a poll is slow. */
  async fetchData() {
    if (typeof fetch !== "function") {
      this.sendError(
        "global fetch is unavailable — Node 18+ is required to run this module"
      );
      return;
    }
    if (this.busy) {
      this.log("fetch already in progress, skipping this tick");
      return;
    }
    this.busy = true;
    try {
      await this.ensureAuthenticated();
      const circles = await this.getCircles();
      const members = await this.getMembersForCircles(circles);
      this.log(`fetched ${members.length} member(s) from ${circles.length} circle(s)`);
      this.sendData(members);
    } catch (err) {
      // A 401 likely means the cached token expired; drop it so the next
      // tick re-authenticates from scratch.
      if (err && err.status === 401) {
        this.warn("access token rejected (401); clearing cached token");
        this.accessToken = null;
      }
      this.sendError(err && err.message ? err.message : String(err));
    } finally {
      this.busy = false;
    }
  },

  /** Obtain an access token, either from config or via password login. */
  async ensureAuthenticated() {
    if (this.accessToken) {
      return;
    }
    if (this.config.accessToken) {
      this.log("using access token supplied in config");
      this.accessToken = this.config.accessToken;
      return;
    }
    if (!this.config.email || !this.config.password) {
      throw new Error(
        "no credentials configured — set email + password or accessToken"
      );
    }

    this.log("authenticating with Life360");
    const body = new URLSearchParams({
      grant_type: "password",
      username: this.config.email,
      password: this.config.password
    });

    const res = await fetch(`${BASE_URL}/v3/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${this.config.authToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": "com.life360.android.safetymapd/KOKO/23.0.0 android/12"
      },
      body
    });

    if (!res.ok) {
      const text = await this.safeText(res);
      const err = new Error(
        `authentication failed (${res.status} ${res.statusText}) ${text}`
      );
      err.status = res.status;
      throw err;
    }

    const data = await res.json();
    if (!data.access_token) {
      throw new Error("authentication succeeded but no access_token returned");
    }
    this.accessToken = data.access_token;
    this.log("authentication successful");
  },

  /** GET helper that attaches the bearer token and parses JSON. */
  async apiGet(path) {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: "application/json",
        "User-Agent": "com.life360.android.safetymapd/KOKO/23.0.0 android/12"
      }
    });

    if (!res.ok) {
      const text = await this.safeText(res);
      const err = new Error(
        `request to ${path} failed (${res.status} ${res.statusText}) ${text}`
      );
      err.status = res.status;
      throw err;
    }
    return res.json();
  },

  /** Fetch circles, honouring an optional configured circleId filter. */
  async getCircles() {
    const data = await this.apiGet("/v3/circles");
    let circles = (data && data.circles) || [];

    if (this.config.circleId) {
      circles = circles.filter((c) => c.id === this.config.circleId);
      if (circles.length === 0) {
        throw new Error(
          `configured circleId "${this.config.circleId}" was not found`
        );
      }
    }

    if (circles.length === 0) {
      throw new Error("no Life360 circles found for this account");
    }
    return circles;
  },

  /** Fetch and merge members across all requested circles (deduped by id). */
  async getMembersForCircles(circles) {
    const byId = new Map();

    for (const circle of circles) {
      let data;
      try {
        data = await this.apiGet(`/v3/circles/${circle.id}/members`);
      } catch (err) {
        this.warn(
          `could not load members for circle "${circle.name}": ${err.message}`
        );
        continue;
      }

      const rawMembers = (data && data.members) || [];
      for (const raw of rawMembers) {
        const normalised = this.normaliseMember(raw, circle);
        if (!byId.has(normalised.id)) {
          byId.set(normalised.id, normalised);
        }
      }
    }

    return Array.from(byId.values());
  },

  /** Turn a raw Life360 member into the shape the frontend expects. */
  normaliseMember(raw, circle) {
    const loc = raw.location || {};
    const name = [raw.firstName, raw.lastName].filter(Boolean).join(" ").trim();

    const toNum = (v) => {
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : null;
    };

    return {
      id: raw.id,
      name: name || "Unknown",
      firstName: raw.firstName || "",
      circleName: circle.name || "",
      avatar: raw.avatar || null,
      latitude: toNum(loc.latitude),
      longitude: toNum(loc.longitude),
      placeName: loc.name || "",
      address: [loc.address1, loc.address2].filter(Boolean).join(", "),
      battery: toNum(loc.battery),
      isCharging: loc.charge === "1" || loc.charge === 1 || loc.charge === true,
      isDriving: loc.isDriving === "1" || loc.isDriving === 1 || loc.isDriving === true,
      wifiState: loc.wifiState === "1" || loc.wifiState === 1,
      speed: toNum(loc.speed),
      timestamp: toNum(loc.timestamp)
    };
  },

  /** Read a response body as text without throwing. */
  async safeText(res) {
    try {
      const t = await res.text();
      return t ? `- ${t.slice(0, 200)}` : "";
    } catch (e) {
      return "";
    }
  }
});
