#!/usr/bin/env node
/**
 * MMM-Life360 — get-token.js
 *
 * A tiny standalone helper to obtain a Life360 access token once, from the
 * command line, so you can paste it into your MagicMirror config as
 * `accessToken`. Handy when the module's automatic login is being blocked
 * (Cloudflare 403), because you can run this from a residential IP / your
 * laptop instead of the Pi.
 *
 * Life360 does NOT issue refresh tokens — this simply performs the same
 * password grant the module uses and prints the resulting access_token.
 *
 * Usage:
 *   node get-token.js                       # prompts for email + password
 *   node get-token.js you@example.com       # prompts for password only
 *   LIFE360_EMAIL=... LIFE360_PASSWORD=... node get-token.js   # non-interactive
 *   node get-token.js --save                # also write the token cache file
 *
 * Requires Node 18+ (uses the global fetch API).
 */
"use strict";

const readline = require("readline");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const MODULE_NAME = "MMM-Life360";
const BASE_URL = "https://api-cloudfront.life360.com";
const TOKEN_PATH = "/v3/oauth2/token";
const USER_AGENT = "com.life360.android.safetymapd/KOKO/23.49.0 android/13";
// Long-standing community client token; override with LIFE360_AUTH_TOKEN.
const AUTH_TOKEN =
  process.env.LIFE360_AUTH_TOKEN ||
  "cSgLxOgW7Jm7AbNa16Ki7lhCUcUhCz2Uv6EWt66zBrIZ0Wz7DKZ0lStY1vAP1nA7EObZ8i";
// A modern Chrome JA3 so Cloudflare sees a browser-like TLS fingerprint.
// Node's built-in fetch/undici fingerprint is frequently blocked with 403.
const JA3 =
  process.env.LIFE360_JA3 ||
  "771,4865-4867-4866-49195-49199-52393-52392-49196-49200-49162-49161-49171-49172-51-57-47-53-10,0-23-65281-10-11-35-16-5-51-43-13-45-28-21,29-23-24-25-256-257,0";

const CACHE_FILE = path.join(__dirname, ".life360-token.json");

function log(msg) {
  console.error(`[${MODULE_NAME}] ${msg}`); // logs go to stderr...
}

function headerOf(headers, name) {
  const h = headers || {};
  const want = name.toLowerCase();
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === want) {
      return Array.isArray(h[k]) ? h[k].join(",") : h[k];
    }
  }
  return "";
}

// cycletls 2.x exposes the payload on resp.data (NOT resp.body) and does not
// decompress it. Turn resp.data into raw bytes, then inflate per encoding.
function cycleRawBuffer(resp) {
  const d = resp && resp.data;
  if (d == null) {
    if (resp && typeof resp.text === "string") return Buffer.from(resp.text, "utf8");
    return Buffer.alloc(0);
  }
  if (Buffer.isBuffer(d)) return d;
  if (d && Array.isArray(d.data)) return Buffer.from(d.data);
  if (Array.isArray(d)) return Buffer.from(d);
  if (d instanceof ArrayBuffer) return Buffer.from(d);
  if (typeof d === "string") return Buffer.from(d, "utf8");
  if (typeof d === "object") {
    try {
      return Buffer.from(JSON.stringify(d), "utf8");
    } catch (e) {
      return Buffer.alloc(0);
    }
  }
  return Buffer.alloc(0);
}

function decodeCycleBody(resp) {
  const buf = cycleRawBuffer(resp);
  if (!buf.length) return "";
  const enc = String(headerOf(resp.headers, "content-encoding") || "").toLowerCase();
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
    /* fall through */
  }
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      return zlib.gunzipSync(buf).toString("utf8");
    } catch (e) {
      /* ignore */
    }
  }
  return buf.toString("utf8");
}

/** Prompt for a line of input (optionally masking, for passwords). */
function prompt(question, { mask = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true
    });

    if (mask) {
      // Replace echoed characters with '*'.
      const onData = (char) => {
        const s = String(char);
        if (s === "\n" || s === "\r" || s === "") {
          process.stdout.write("\n");
        } else {
          // Move to line start, rewrite prompt + mask.
          rl.output.write(`\r${question}${"*".repeat(rl.line.length)}`);
        }
      };
      process.stdin.on("data", onData);
      rl.question(question, (answer) => {
        process.stdin.removeListener("data", onData);
        rl.close();
        resolve(answer);
      });
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

/**
 * POST the password grant. Prefer cycletls (browser TLS fingerprint) so
 * Cloudflare doesn't 403 us; fall back to native fetch if cycletls isn't
 * installed. Returns { status, statusText, bodyText, transport }.
 */
async function postToken(bodyString) {
  const headers = {
    Authorization: `Basic ${AUTH_TOKEN}`,
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    // Request an uncompressed body: cycletls doesn't auto-decode compression, so
    // a compressed reply would arrive as an empty 200. identity avoids that.
    "Accept-Encoding": "identity",
    "cache-control": "no-cache",
    "User-Agent": USER_AGENT
  };

  // Try cycletls first.
  let initCycleTLS = null;
  try {
    initCycleTLS = require("cycletls");
  } catch (e) {
    log(
      "cycletls not installed — using native fetch (more likely to hit a " +
        "Cloudflare 403). Run `npm install` in the module folder to enable it."
    );
  }

  if (initCycleTLS) {
    let client;
    try {
      client = await initCycleTLS();
      const resp = await client(
        `${BASE_URL}${TOKEN_PATH}`,
        {
          body: bodyString,
          headers,
          ja3: JA3,
          userAgent: USER_AGENT,
          timeout: 30
        },
        "post"
      );
      // cycletls 2.x: body is on resp.data, not resp.body, and isn't decoded.
      const bodyText = decodeCycleBody(resp);
      return {
        status: resp.status,
        statusText: "",
        bodyText,
        transport: "cycletls"
      };
    } catch (e) {
      log(`cycletls request failed (${e.message}); falling back to fetch`);
    } finally {
      if (client && typeof client.exit === "function") {
        try {
          client.exit();
        } catch (e) {
          /* ignore */
        }
      }
    }
  }

  // Native fetch fallback.
  if (typeof fetch !== "function") {
    throw new Error("global fetch is unavailable — Node 18+ is required");
  }
  const res = await fetch(`${BASE_URL}${TOKEN_PATH}`, {
    method: "POST",
    headers,
    body: bodyString
  });
  return {
    status: res.status,
    statusText: res.statusText,
    bodyText: await res.text(),
    transport: "fetch"
  };
}

async function login(email, password) {
  log("authenticating with Life360 (password grant)…");
  const bodyString = new URLSearchParams({
    grant_type: "password",
    username: email,
    password
  }).toString();

  const resp = await postToken(bodyString);
  const ok = resp.status >= 200 && resp.status < 300;

  if (!ok) {
    let hint = "";
    if (resp.status === 403) {
      hint =
        "\n  → 403 is usually Cloudflare TLS fingerprinting (Node/curl stacks " +
        "are blocked), 2FA on the account, or bot-protection.\n" +
        `    This attempt used the "${resp.transport}" transport. If that was ` +
        "'fetch', run `npm install` to enable cycletls and retry.\n" +
        "    Otherwise capture a token from the Life360 app (see README).";
    }
    throw new Error(
      `authentication failed (${resp.status} ${resp.statusText})${hint}\n  ${resp.bodyText.slice(
        0,
        300
      )}`
    );
  }

  let data;
  try {
    data = JSON.parse(resp.bodyText);
  } catch (e) {
    throw new Error(`could not parse token response: ${resp.bodyText.slice(0, 200)}`);
  }
  if (!data.access_token) {
    throw new Error("authentication succeeded but no access_token was returned");
  }
  log(`token obtained via ${resp.transport}`);
  return data.access_token;
}

async function main() {
  const args = process.argv.slice(2);
  const save = args.includes("--save");
  const positional = args.filter((a) => !a.startsWith("--"));

  let email = process.env.LIFE360_EMAIL || positional[0];
  let password = process.env.LIFE360_PASSWORD;

  if (!email) {
    email = (await prompt("Life360 email: ")).trim();
  }
  if (!password) {
    password = await prompt("Life360 password: ", { mask: true });
  }
  if (!email || !password) {
    log("email and password are both required");
    process.exit(1);
  }

  const token = await login(email, password);

  log("success! Access token below.\n");
  // The token itself goes to stdout so it can be captured/piped cleanly.
  console.log(token);

  log("");
  log("Add this to your config.js:");
  log(`    accessToken: "${token}"`);

  if (save) {
    try {
      fs.writeFileSync(
        CACHE_FILE,
        JSON.stringify({ access_token: token, savedAt: new Date().toISOString() }),
        { mode: 0o600 }
      );
      try {
        fs.chmodSync(CACHE_FILE, 0o600);
      } catch (e) {
        /* best effort on non-POSIX filesystems */
      }
      log(`also saved to ${CACHE_FILE} (the module will pick this up)`);
    } catch (e) {
      log(`could not write cache file: ${e.message}`);
    }
  }
}

main().catch((err) => {
  log(err && err.message ? err.message : String(err));
  process.exit(1);
});
