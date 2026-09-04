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
 * Cloudflare TLS fingerprinting (why we don't just use fetch)
 * ----------------------------------------------------------
 * Life360's API sits behind Cloudflare, which fingerprints the TLS ClientHello
 * (JA3/JA4). Requests from Node's built-in fetch / undici (and plain curl) are
 * frequently rejected with HTTP 403 *regardless* of headers, payload or IP —
 * see pnbruckner/life360#22 and pnbruckner/ha-life360#84 & #99. To look like a
 * real browser at the TLS layer we route requests through `cycletls` (a Go TLS
 * client with a configurable JA3). If cycletls can't be loaded we fall back to
 * native fetch with a clear warning — the module keeps working wherever fetch
 * happens to be accepted.
 *
 * Token handling
 * --------------
 * Life360's OAuth "password" grant returns ONLY an access_token — there is no
 * refresh_token and no expires_in. The token is long-lived (valid until it is
 * revoked server-side), so there is no background "refresh" flow possible; the
 * only way to obtain a new token is to log in again with the password.
 *
 * To keep logins to a minimum (repeated logins are a common 403 trigger) the
 * helper caches a working token to disk, reuses it across restarts, and only
 * re-logs-in on a 401 when email + password are configured.
 *
 * All log lines are prefixed with the module name.
 *
 * Requires Node 18+ (uses the global fetch API as a fallback transport).
 */
const NodeHelper = require("node_helper");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const MODULE_NAME = "MMM-Life360";
// Two known API hosts. `api.life360.com` is the one the community library that
// "just works" (pnbruckner/life360) uses; `api-cloudfront.life360.com` is more
// aggressively fingerprint-guarded. Configurable via config.baseUrl.
const DEFAULT_BASE_URL = "https://api.life360.com";
const TOKEN_PATH = "/v3/oauth2/token";

// Sensible defaults; all are overridable via config.
const DEFAULT_USER_AGENT =
  "com.life360.android.safetymapd/KOKO/23.49.0 android/13";
const DEFAULT_AUTH_TOKEN =
  "cSgLxOgW7Jm7AbNa16Ki7lhCUcUhCz2Uv6EWt66zBrIZ0Wz7DKZ0lStY1vAP1nA7EObZ8i";
// A modern Chrome JA3. Cloudflare readily accepts browser ClientHellos, whereas
// Node/undici and curl fingerprints are often blocked. Tunable via config.ja3
// if Life360 starts blocking this one too.
const DEFAULT_JA3 =
  "771,4865-4867-4866-49195-49199-52393-52392-49196-49200-49162-49161-49171-49172-51-57-47-53-10,0-23-65281-10-11-35-16-5-51-43-13-45-28-21,29-23-24-25-256-257,0";

module.exports = NodeHelper.create({
  start() {
    this.accessToken = null;
    this.tokenSource = null; // "cache" | "config" | "login"
    this.deadToken = null; // a token we know is bad and cannot refresh
    this.config = null;
    this.busy = false;

    // TLS-impersonation client (cycletls) lifecycle.
    this.cycleClient = null;
    this.cycleInitPromise = null;
    this.cycleFailed = false; // give up on cycletls after a hard failure

    this.log("node_helper started");
  },

  /** Best-effort cleanup of the cycletls Go process on shutdown. */
  stop() {
    if (this.cycleClient && typeof this.cycleClient.exit === "function") {
      try {
        this.cycleClient.exit();
      } catch (e) {
        /* ignore */
      }
    }
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

  baseUrl() {
    return (this.config && this.config.baseUrl) || DEFAULT_BASE_URL;
  },

  ja3() {
    return (this.config && this.config.ja3) || DEFAULT_JA3;
  },

  useImpersonation() {
    // On by default; set useImpersonation:false to force native fetch.
    return !this.config || this.config.useImpersonation !== false;
  },

  canLogin() {
    return !!(this.config && this.config.email && this.config.password);
  },

  cacheEnabled() {
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
    // NB: Accept-Encoding is intentionally NOT set here. cycletls only decodes
    // a compressed response reliably when we let it manage the encoding itself
    // (a manually-set Accept-Encoding disables its auto-decompression, yielding
    // an HTTP 200 with an empty body). httpRequest() negotiates the encoding
    // per-transport; native fetch/undici decodes gzip/deflate/br on its own.
    return Object.assign(
      {
        Accept: "application/json",
        "cache-control": "no-cache",
        "User-Agent": this.userAgent()
      },
      extra || {}
    );
  },

  // --- HTTP transport -------------------------------------------------------
  /**
   * Lazily initialise the cycletls client. Returns null (and remembers the
   * failure) if the package isn't installed or the Go process won't start, so
   * callers transparently fall back to native fetch.
   */
  async getCycleClient() {
    if (!this.useImpersonation() || this.cycleFailed) {
      return null;
    }
    if (this.cycleClient) {
      return this.cycleClient;
    }
    if (!this.cycleInitPromise) {
      this.cycleInitPromise = (async () => {
        let initCycleTLS;
        try {
          initCycleTLS = require("cycletls");
        } catch (e) {
          this.warn(
            "cycletls is not installed — run `npm install` in the module " +
              "folder to enable TLS impersonation (recommended to avoid " +
              "Life360's Cloudflare 403s). Falling back to native fetch."
          );
          this.cycleFailed = true;
          return null;
        }
        try {
          const client = await initCycleTLS();
          this.cycleClient = client;
          this.log("TLS impersonation enabled (cycletls)");
          return client;
        } catch (e) {
          this.warn(
            `could not start cycletls (${e.message}); falling back to native fetch`
          );
          this.cycleFailed = true;
          return null;
        }
      })();
    }
    return this.cycleInitPromise;
  },

  /**
   * Perform an HTTP request via cycletls (preferred) or native fetch.
   * Returns a normalised { status, ok, statusText, bodyText, transport }.
   */
  async httpRequest(method, url, opts) {
    const options = opts || {};
    const headers = options.headers || {};
    const body = options.body;

    const client = await this.getCycleClient();
    if (client) {
      try {
        const resp = await client(
          url,
          {
            body: body || "",
            headers,
            ja3: this.ja3(),
            userAgent: headers["User-Agent"] || this.userAgent(),
            timeout: 30,
            disableRedirect: false
          },
          method.toLowerCase()
        );

        // IMPORTANT: cycletls 2.x does NOT expose `resp.body`. Its response is
        // { status, headers, finalUrl, data, json/text/... }. Reading the
        // (non-existent) `resp.body` is what made every call look "empty".
        // `decodeCycleBody` reads the real bytes from `resp.data` and inflates
        // them according to Content-Encoding (Life360 replies with gzip).
        const bodyText = this.decodeCycleBody(resp);

        return {
          status: resp.status,
          ok: resp.status >= 200 && resp.status < 300,
          statusText: "",
          bodyText,
          headers: resp.headers || {},
          transport: "cycletls"
        };
      } catch (e) {
        // A transport-level failure (not an HTTP error) — try fetch as a
        // last resort rather than failing the whole poll.
        this.warn(
          `cycletls request failed (${e.message}); retrying with native fetch`
        );
      }
    }

    // Native fetch fallback.
    const res = await fetch(url, { method, headers, body });
    const bodyText = await this.readText(res);
    const hdrs = {};
    try {
      res.headers.forEach((v, k) => {
        hdrs[k] = v;
      });
    } catch (e) {
      /* ignore */
    }
    return {
      status: res.status,
      ok: res.ok,
      statusText: res.statusText,
      bodyText,
      headers: hdrs,
      transport: "fetch"
    };
  },

  /** Read a fetch response body as text without throwing. */
  async readText(res) {
    try {
      return await res.text();
    } catch (e) {
      return "";
    }
  },

  /**
   * Extract the raw response bytes from a cycletls 2.x response.
   * cycletls exposes the payload on `resp.data`, which may be a Buffer, a
   * { type: "Buffer", data: [...] } shape, a plain array of byte values, an
   * ArrayBuffer, a string, or — for an already-parsed JSON response — an
   * object/array. Returns a Buffer (empty if there's nothing usable).
   */
  cycleRawBuffer(resp) {
    const d = resp && resp.data;
    if (d == null) {
      // Some builds only fill `text`; fall back to it if present as a string.
      if (resp && typeof resp.text === "string") {
        return Buffer.from(resp.text, "utf8");
      }
      return Buffer.alloc(0);
    }
    if (Buffer.isBuffer(d)) return d;
    if (d && Array.isArray(d.data)) return Buffer.from(d.data); // {type:"Buffer",data:[]}
    if (Array.isArray(d)) return Buffer.from(d);
    if (d instanceof ArrayBuffer) return Buffer.from(d);
    if (typeof d === "string") return Buffer.from(d, "utf8");
    // Already-parsed object/array (uncompressed JSON) — re-serialise it.
    if (typeof d === "object") {
      try {
        return Buffer.from(JSON.stringify(d), "utf8");
      } catch (e) {
        return Buffer.alloc(0);
      }
    }
    return Buffer.alloc(0);
  },

  /**
   * Decode a cycletls 2.x response body to a UTF-8 string, decompressing per
   * the Content-Encoding header (cycletls does NOT auto-decompress). Handles
   * gzip, deflate and brotli, sniffs the gzip magic number as a fallback, and
   * returns plain UTF-8 when the payload isn't compressed.
   */
  decodeCycleBody(resp) {
    const buf = this.cycleRawBuffer(resp);
    if (!buf.length) return "";

    const enc = String(this.header(resp, "content-encoding") || "").toLowerCase();
    try {
      if (enc.includes("br")) return zlib.brotliDecompressSync(buf).toString("utf8");
      if (enc.includes("gzip")) return zlib.gunzipSync(buf).toString("utf8");
      if (enc.includes("deflate")) {
        try {
          return zlib.inflateSync(buf).toString("utf8");
        } catch (e) {
          return zlib.inflateRawSync(buf).toString("utf8");
        }
      }
    } catch (e) {
      this.warn(`failed to decompress ${enc} response (${e.message}); using raw bytes`);
    }

    // No/unknown encoding: sniff the gzip magic bytes in case the header lied.
    if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
      try {
        return zlib.gunzipSync(buf).toString("utf8");
      } catch (e) {
        /* fall through to raw */
      }
    }
    return buf.toString("utf8");
  },

  /** Trim a response body for inclusion in an error message. */
  snippet(text) {
    return text ? `- ${String(text).slice(0, 200)}` : "";
  },

  /** Case-insensitive header lookup on a normalised response. */
  header(resp, name) {
    const h = (resp && resp.headers) || {};
    const want = name.toLowerCase();
    for (const k of Object.keys(h)) {
      if (k.toLowerCase() === want) {
        return Array.isArray(h[k]) ? h[k].join(",") : h[k];
      }
    }
    return "";
  },

  /**
   * Work out WHY a request failed and log an actionable diagnosis. The key
   * question on a 403 is "Cloudflare bot-block" vs "Life360 rejected the
   * request", because they need opposite fixes.
   */
  diagnose(resp, context) {
    const server = this.header(resp, "server");
    const cfRay = this.header(resp, "cf-ray");
    const cfMitigated = this.header(resp, "cf-mitigated");
    const body = (resp.bodyText || "").toLowerCase();

    const looksCloudflare =
      /cloudflare/i.test(server) ||
      !!cfRay ||
      !!cfMitigated ||
      body.includes("cloudflare") ||
      body.includes("attention required") ||
      body.includes("<!doctype html");

    this.warn(
      `${context}: HTTP ${resp.status} via ${resp.transport} ` +
        `(server="${server || "?"}"${cfRay ? `, cf-ray=${cfRay}` : ""}` +
        `${cfMitigated ? `, cf-mitigated=${cfMitigated}` : ""})`
    );

    if (resp.status === 403 && looksCloudflare) {
      this.warn(
        `${context}: this is a CLOUDFLARE block (TLS fingerprint), not a ` +
          "credential problem. Things to try: (1) confirm cycletls is active " +
          "in the log above, not a fetch fallback; (2) switch baseUrl to the " +
          "other host; (3) set a different ja3; (4) capture a token from the " +
          "Life360 app (README → Getting an access token)."
      );
    } else if (resp.status === 403) {
      this.warn(
        `${context}: 403 from Life360 (not Cloudflare) — usually bad ` +
          "credentials, a stale authToken/client id, or 2FA on the account."
      );
    }

    // Always show a short body snippet — it's the fastest way to tell HTML
    // (Cloudflare) from JSON (Life360) at a glance.
    if (resp.bodyText) {
      this.warn(`${context}: body ${this.snippet(resp.bodyText)}`);
    }
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
    }).toString();

    const resp = await this.httpRequest("POST", `${this.baseUrl()}${TOKEN_PATH}`, {
      headers: this.mobileHeaders({
        Authorization: `Basic ${this.authToken()}`,
        "Content-Type": "application/x-www-form-urlencoded"
      }),
      body
    });

    if (!resp.ok) {
      this.diagnose(resp, "login");
      const err = new Error(
        `authentication failed (${resp.status} ${resp.statusText}) ` +
          `${this.snippet(resp.bodyText)}`
      );
      err.status = resp.status;
      throw err;
    }

    let data;
    try {
      data = JSON.parse(resp.bodyText);
    } catch (e) {
      throw new Error(
        `could not parse token response: ${this.snippet(resp.bodyText)}`
      );
    }
    if (!data.access_token) {
      throw new Error("authentication succeeded but no access_token returned");
    }

    this.accessToken = data.access_token;
    this.tokenSource = "login";
    this.deadToken = null;
    this.saveCachedToken(this.accessToken);
    this.log(`authentication successful (via ${resp.transport})`);
  },

  /** GET helper that attaches the bearer token and parses JSON. */
  async apiGet(apiPath) {
    const resp = await this.httpRequest("GET", `${this.baseUrl()}${apiPath}`, {
      headers: this.mobileHeaders({
        Authorization: `Bearer ${this.accessToken}`
      })
    });

    if (!resp.ok) {
      this.diagnose(resp, `GET ${apiPath}`);
      const err = new Error(
        `request to ${apiPath} failed (${resp.status} ${resp.statusText}) ` +
          `${this.snippet(resp.bodyText)}`
      );
      err.status = resp.status;
      throw err;
    }

    // A 200 with a genuinely empty body is unusual now that we read the body
    // correctly (cycletls 2.x puts it on `resp.data`, decoded by
    // decodeCycleBody). If it still happens, surface a clear error.
    if (!resp.bodyText || !resp.bodyText.trim()) {
      throw new Error(
        `empty response body from ${apiPath} (HTTP ${resp.status} via ` +
          `${resp.transport}). Run \`node diagnose.js --token\` to inspect the ` +
          "raw response."
      );
    }

    try {
      return JSON.parse(resp.bodyText);
    } catch (e) {
      throw new Error(
        `could not parse response from ${apiPath}: ${this.snippet(resp.bodyText)}`
      );
    }
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
  }
});
