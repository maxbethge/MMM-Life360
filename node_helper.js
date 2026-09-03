/**
 * MMM-Life360 — node_helper
 *
 * Handles all communication with the Life360 API:
 *   1. Authenticates (email/password -> access token) or uses a supplied /
 *      cached token.
 *   2. Fetches the circles you belong to.
 *   3. Fetches the members (with locations) for each circle.
 *   4. Normalises the data and sends it back to the browser module.
 *
 * Token handling
 * --------------
 * Life360's OAuth "password" grant returns ONLY an access_token — there is no
 * refresh_token and no expires_in. The token is long-lived (valid until it is
 * revoked server-side), so there is no background "refresh" flow possible; the
 * only way to obtain a new token is to log in again with the password.
 *
 * To keep logins to a minimum (repeated logins are what trigger Life360's
 * Cloudflare 403s) the helper:
 *   - caches a working token to disk and reuses it across restarts;
 *   - only logs in when it has no usable token;
 *   - on a 401 (token rejected) it re-logs-in automatically IF email+password
 *     are configured, otherwise it surfaces a clear "grab a new token" message.
 *
 * All API calls send mobile-app-style headers (User-Agent + cache-control) so
 * the request looks like it comes from the official app.
 *
 * All log lines are prefixed with the module name.
 *
 * Requires Node 18+ (uses the global fetch API).
 */
const NodeHelper = require("node_helper");
const fs = require("fs");
const path = require("path");

const MODULE_NAME = "MMM-Life360";
const BASE_URL = "https://api-cloudfront.life360.com";
const TOKEN_PATH = "/v3/oauth2/token";

// Sensible defaults; both are overridable via config.
const DEFAULT_USER_AGENT =
  "com.life360.android.safetymapd/KOKO/23.49.0 android/13";
const DEFAULT_AUTH_TOKEN =
  "cSgLxOgW7Jm7AbNa16Ki7lhCUcUhCz2Uv6EWt66zBrIZ0Wz7DKZ0lStY1vAP1nA7EObZ8i";

module.exports = NodeHelper.create({
  start() {
    this.accessToken = null;
    this.tokenSource = null; // "cache" | "config" | "login"
    this.deadToken = null; // a token we know is bad and cannot refresh
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

  // --- config-derived helpers ----------------------------------------------
  userAgent() {
    return (this.config && this.config.userAgent) || DEFAULT_USER_AGENT;
  },

  authToken() {
    return (this.config && this.config.authToken) || DEFAULT_AUTH_TOKEN;
  },

  canLogin() {
    return !!(this.config && this.config.email && this.config.password);
  },

  cacheEnabled() {
    // Caching is on by default; set cacheToken:false to disable.
    return !this.config || this.config.cacheToken !== false;
  },

  tokenCachePath() {
    return (
      (this.config && this.config.tokenCachePath) ||
      path.join(__dirname, ".life360-token.json")
    );
  },

  /** Mobile-app-style headers shared by every request. */
  mobileHeaders(extra) {
    return Object.assign(
      {
        Accept: "application/json",
        "cache-control": "no-cache",
        "User-Agent": this.userAgent()
      },
      extra || {}
    );
  },

  // --- token cache (disk) ---------------------------------------------------
  loadCachedToken() {
    if (!this.cacheEnabled()) {
      return null;
    }
    try {
      const raw = fs.readFileSync(this.tokenCachePath(), "utf8");
      const obj = JSON.parse(raw);
      return obj && obj.access_token ? obj.access_token : null;
    } catch (e) {
      return null; // no cache yet / unreadable — treat as "no token"
    }
  },

  saveCachedToken(token) {
    if (!this.cacheEnabled()) {
      return;
    }
    const file = this.tokenCachePath();
    try {
      fs.writeFileSync(
        file,
        JSON.stringify({ access_token: token, savedAt: new Date().toISOString() }),
        { mode: 0o600 }
      );
      // Ensure restrictive perms even if the file already existed.
      try {
        fs.chmodSync(file, 0o600);
      } catch (e) {
        /* best effort (e.g. Windows) */
      }
      this.log(`cached access token to ${file}`);
    } catch (e) {
      this.warn(`could not cache token: ${e.message}`);
    }
  },

  /** Forget the current token everywhere (memory + disk). */
  invalidateToken() {
    this.accessToken = null;
    this.tokenSource = null;
    if (!this.cacheEnabled()) {
      return;
    }
    try {
      fs.unlinkSync(this.tokenCachePath());
    } catch (e) {
      /* nothing cached — fine */
    }
  },

  /** A clear, actionable error for when we have no way to get a valid token. */
  expiredTokenError() {
    const err = new Error(
      "access token is invalid, expired, or revoked. Provide a fresh " +
        "accessToken (see README → \"Getting an access token\", or run " +
        "`node get-token.js`), or set email + password so the module can " +
        "refresh it automatically."
    );
    err.tokenExpired = true;
    return err;
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
      await this.loadDataWithRetry();
    } catch (err) {
      this.sendError(err && err.message ? err.message : String(err));
    } finally {
      this.busy = false;
    }
  },

  /**
   * Authenticate + fetch. On a 401 (token rejected), re-authenticate once with
   * stored credentials and retry; if we can't log in, surface a clear message.
   */
  async loadDataWithRetry() {
    await this.ensureAuthenticated(false);
    try {
      await this.loadData();
    } catch (err) {
      if (!err || err.status !== 401) {
        throw err;
      }

      this.warn("access token rejected (401)");
      const failed = this.accessToken;
      this.invalidateToken();

      if (this.canLogin()) {
        this.log("re-authenticating with stored credentials");
        await this.ensureAuthenticated(true); // force a fresh password login
        await this.loadData(); // retry once
        return;
      }

      // Token-only setup: nothing to refresh with. Remember the bad token so
      // we stop hammering the API with it on every subsequent tick.
      this.deadToken = failed;
      throw this.expiredTokenError();
    }
  },

  /** Fetch circles + members and push them to the frontend. */
  async loadData() {
    const circles = await this.getCircles();
    const members = await this.getMembersForCircles(circles);
    this.log(
      `fetched ${members.length} member(s) from ${circles.length} circle(s)`
    );
    this.sendData(members);
  },

  /**
   * Ensure this.accessToken holds a usable token.
   * Preference order (when not forcing): in-memory → disk cache → config token.
   * `force` skips all cached sources and performs a fresh password login.
   */
  async ensureAuthenticated(force) {
    if (!force) {
      if (this.accessToken) {
        return;
      }
      const cached = this.loadCachedToken();
      if (cached) {
        this.accessToken = cached;
        this.tokenSource = "cache";
        this.log("using cached access token");
        return;
      }
      if (this.config.accessToken) {
        // Don't keep retrying a config token we've already proven is dead.
        if (this.config.accessToken === this.deadToken && !this.canLogin()) {
          throw this.expiredTokenError();
        }
        this.accessToken = this.config.accessToken;
        this.tokenSource = "config";
        this.log("using access token supplied in config");
        return;
      }
    }

    // Need a fresh token via password login.
    if (!this.canLogin()) {
      // We had a token source that just failed, or none was ever provided.
      throw this.config && this.config.accessToken
        ? this.expiredTokenError()
        : new Error(
            "no credentials configured — set email + password, or provide " +
              "an accessToken (see README → \"Getting an access token\")"
          );
    }

    await this.login();
  },

  /** Exchange email + password for an access token, and cache it. */
  async login() {
    this.log("authenticating with Life360 (password grant)");
    const body = new URLSearchParams({
      grant_type: "password",
      username: this.config.email,
      password: this.config.password
    });

    const res = await fetch(`${BASE_URL}${TOKEN_PATH}`, {
      method: "POST",
      headers: this.mobileHeaders({
        Authorization: `Basic ${this.authToken()}`,
        "Content-Type": "application/x-www-form-urlencoded"
      }),
      body
    });

    if (!res.ok) {
      const text = await this.safeText(res);
      let hint = "";
      if (res.status === 403) {
        hint =
          " — Life360 is blocking this login (Cloudflare bot-protection, " +
          "2FA, or a datacenter/VPN IP). Grab an accessToken manually instead " +
          "(see README → \"Getting an access token\").";
      }
      const err = new Error(
        `authentication failed (${res.status} ${res.statusText})${hint} ${text}`
      );
      err.status = res.status;
      throw err;
    }

    const data = await res.json();
    if (!data.access_token) {
      throw new Error("authentication succeeded but no access_token returned");
    }

    this.accessToken = data.access_token;
    this.tokenSource = "login";
    this.deadToken = null;
    this.saveCachedToken(this.accessToken);
    this.log("authentication successful");
  },

  /** GET helper that attaches the bearer token and parses JSON. */
  async apiGet(path) {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "GET",
      headers: this.mobileHeaders({
        Authorization: `Bearer ${this.accessToken}`
      })
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
        // A 401 here means the token is bad — bubble it up so the retry logic
        // can re-authenticate. Other per-circle errors are non-fatal.
        if (err && err.status === 401) {
          throw err;
        }
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
