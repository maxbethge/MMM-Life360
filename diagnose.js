#!/usr/bin/env node
/**
 * MMM-Life360 — diagnose.js
 *
 * When you're getting 403s, run this to find out EXACTLY what's happening.
 * It attempts the Life360 login across every combination of:
 *   - transport:  cycletls (browser TLS fingerprint)  vs  native fetch
 *   - host:       api.life360.com  vs  api-cloudfront.life360.com
 *
 * For each attempt it prints the HTTP status, the transport actually used, the
 * tell-tale response headers (Server / cf-ray / cf-mitigated) and a short body
 * snippet — so you can instantly tell a Cloudflare TLS block (HTML body,
 * Server: cloudflare) apart from a Life360 credential rejection (JSON body).
 *
 * Nothing here is written to disk and no token is printed in full.
 *
 * Usage (login probe):
 *   node diagnose.js                      # prompts for email + password
 *   node diagnose.js you@example.com
 *   LIFE360_EMAIL=... LIFE360_PASSWORD=... node diagnose.js
 *
 * Usage (token test — for accounts that sign in with an emailed code, i.e.
 * no password login is possible; capture a bearer token from the browser first:
 * log in at life360.com/login with DevTools open and copy access_token from the
 * POST /oauth2/token response — see README Option B):
 *   node diagnose.js --token              # prompts for the token
 *   LIFE360_TOKEN=... node diagnose.js
 * This GETs the real /v3/circles data endpoint to prove the token works
 * end-to-end before you put it in config.
 *
 * Requires Node 18+.
 */
"use strict";

const readline = require("readline");

const MODULE_NAME = "MMM-Life360";
const TOKEN_PATH = "/v3/oauth2/token";
const USER_AGENT = "com.life360.android.safetymapd/KOKO/23.49.0 android/13";
const AUTH_TOKEN =
  process.env.LIFE360_AUTH_TOKEN ||
  "cSgLxOgW7Jm7AbNa16Ki7lhCUcUhCz2Uv6EWt66zBrIZ0Wz7DKZ0lStY1vAP1nA7EObZ8i";
const JA3 =
  process.env.LIFE360_JA3 ||
  "771,4865-4867-4866-49195-49199-52393-52392-49196-49200-49162-49161-49171-49172-51-57-47-53-10,0-23-65281-10-11-35-16-5-51-43-13-45-28-21,29-23-24-25-256-257,0";

const HOSTS = [
  "https://api.life360.com",
  "https://api-cloudfront.life360.com"
];

function log(msg) {
  console.log(`[${MODULE_NAME}] ${msg}`);
}

function prompt(question, { mask = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true
    });
    if (mask) {
      const onData = () => {
        rl.output.write(`\r${question}${"*".repeat(rl.line.length)}`);
      };
      process.stdin.on("data", onData);
      rl.question(question, (answer) => {
        process.stdin.removeListener("data", onData);
        rl.close();
        process.stdout.write("\n");
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

function classify(status, headers, bodyText) {
  const server = headerOf(headers, "server");
  const cfRay = headerOf(headers, "cf-ray");
  const cfMitigated = headerOf(headers, "cf-mitigated");
  const body = (bodyText || "").toLowerCase();
  const looksCloudflare =
    /cloudflare/i.test(server) ||
    !!cfRay ||
    !!cfMitigated ||
    body.includes("cloudflare") ||
    body.includes("attention required") ||
    body.includes("<!doctype html");

  // A 2xx with an unreadable/empty body is NOT a real success: the request got
  // through, but we couldn't decode the payload (usually Brotli that the client
  // didn't decompress). The module would show "success" with no data.
  const raw = (bodyText || "").trim();
  let jsonOk = false;
  if (raw) {
    try {
      JSON.parse(raw);
      jsonOk = true;
    } catch (e) {
      jsonOk = false;
    }
  }

  let verdict;
  let success = false;
  if (status >= 200 && status < 300) {
    if (!raw) {
      verdict =
        "⚠️  200 but EMPTY body — response not decoded (Brotli?). " +
        "Set Accept-Encoding: gzip, deflate.";
    } else if (!jsonOk) {
      verdict = "⚠️  200 but body isn't JSON — check encoding/endpoint.";
    } else {
      verdict = "✅ SUCCESS (valid JSON body)";
      success = true;
    }
  } else if (status === 403 && looksCloudflare) {
    verdict = "⛔ CLOUDFLARE BLOCK (TLS fingerprint) — token won't help";
  } else if (status === 403) {
    verdict = "🔑 LIFE360 REJECTED (credentials / authToken / 2FA)";
  } else if (status === 401) {
    verdict = "🔑 UNAUTHORIZED (token invalid/expired or bad client token)";
  } else if (status === 429) {
    verdict = "⏳ RATE LIMITED — back off and retry later";
  } else {
    verdict = `⚠️  unexpected status ${status}`;
  }

  return { server, cfRay, cfMitigated, verdict, success };
}

function bodyBrief(bodyText) {
  const t = (bodyText || "").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, 160) : "(empty body)";
}

async function tryCycle(host, bodyString, headers) {
  let initCycleTLS;
  try {
    initCycleTLS = require("cycletls");
  } catch (e) {
    return { skipped: "cycletls not installed (run `npm install`)" };
  }
  let client;
  try {
    client = await initCycleTLS();
    const resp = await client(
      `${host}${TOKEN_PATH}`,
      { body: bodyString, headers, ja3: JA3, userAgent: USER_AGENT, timeout: 30 },
      "post"
    );
    const bodyText =
      typeof resp.body === "string" ? resp.body : JSON.stringify(resp.body);
    return { status: resp.status, headers: resp.headers || {}, bodyText };
  } catch (e) {
    return { error: e.message };
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

async function tryFetch(host, bodyString, headers) {
  if (typeof fetch !== "function") {
    return { skipped: "global fetch unavailable (need Node 18+)" };
  }
  try {
    const res = await fetch(`${host}${TOKEN_PATH}`, {
      method: "POST",
      headers,
      body: bodyString
    });
    const bodyText = await res.text();
    const hdrs = {};
    res.headers.forEach((v, k) => {
      hdrs[k] = v;
    });
    return { status: res.status, headers: hdrs, bodyText };
  } catch (e) {
    return { error: e.message };
  }
}

// --- token-test mode: GET a data endpoint with a captured bearer token -----
// cycletls does not auto-decompress responses. If we let Cloudflare pick an
// encoding (Brotli by default) cycletls hands back an unreadable body, which
// shows up as a 200 with an EMPTY body. So we sweep several Accept-Encoding
// strategies and report which one actually returns a real (JSON) body:
//   identity        → ask for uncompressed; nothing to decode (most robust)
//   (client-managed)→ send no Accept-Encoding; cycletls adds+decodes gzip
//   gzip, deflate   → the old default (often still empty on cycletls)
const CYCLE_ENCODINGS = [
  { label: "identity", value: "identity" },
  { label: "client-managed", value: null },
  { label: "gzip, deflate", value: "gzip, deflate" }
];

async function getCycle(host, path, baseHeaders) {
  let initCycleTLS;
  try {
    initCycleTLS = require("cycletls");
  } catch (e) {
    return { skipped: "cycletls not installed (run `npm install`)" };
  }
  let client;
  try {
    client = await initCycleTLS();
    let last = null;
    for (const enc of CYCLE_ENCODINGS) {
      const headers = Object.assign({}, baseHeaders);
      if (enc.value) {
        headers["Accept-Encoding"] = enc.value;
      } else {
        delete headers["Accept-Encoding"];
      }
      const resp = await client(
        `${host}${path}`,
        { headers, ja3: JA3, userAgent: USER_AGENT, timeout: 30 },
        "get"
      );
      const bodyText =
        typeof resp.body === "string" ? resp.body : JSON.stringify(resp.body);
      last = {
        status: resp.status,
        headers: resp.headers || {},
        bodyText,
        encoding: enc.label
      };
      const ok2xx = resp.status >= 200 && resp.status < 300;
      const hasBody = !!(bodyText && bodyText.trim());
      // Stop at the first strategy that yields a usable body, OR any non-2xx
      // (an empty 2xx just means "this encoding failed — try the next one").
      if (!ok2xx || hasBody) {
        return last;
      }
    }
    return last;
  } catch (e) {
    return { error: e.message };
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

async function getFetch(host, path, headers) {
  if (typeof fetch !== "function") {
    return { skipped: "global fetch unavailable (need Node 18+)" };
  }
  try {
    const res = await fetch(`${host}${path}`, { method: "GET", headers });
    const bodyText = await res.text();
    const hdrs = {};
    res.headers.forEach((v, k) => {
      hdrs[k] = v;
    });
    return { status: res.status, headers: hdrs, bodyText };
  } catch (e) {
    return { error: e.message };
  }
}

async function testToken(token) {
  // No Accept-Encoding here: getCycle() sweeps encodings for cycletls, and
  // native fetch decodes gzip/deflate/br on its own.
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "cache-control": "no-cache",
    "User-Agent": USER_AGENT
  };
  const path = "/v3/circles";

  log("Testing your captured token against the /v3/circles DATA endpoint…");
  log("(this is what the module actually calls on every refresh)");
  log("cycletls rows sweep Accept-Encoding: identity → client-managed → gzip.");

  let winner = null;
  for (const host of HOSTS) {
    const c = await getCycle(host, path, headers);
    if (report(`cycletls  →  ${host}${path}`, c)) {
      winner = { host, transport: "cycletls", encoding: c.encoding };
    }
    const f = await getFetch(host, path, headers);
    if (report(`fetch     →  ${host}${path}`, f)) {
      winner = winner || { host, transport: "fetch" };
    }
  }

  log("");
  log("──────────── SUMMARY ────────────");
  if (winner) {
    log("✅ Your captured token WORKS for data requests. In config.js set:");
    log(`   accessToken: "<your token>"`);
    log(`   baseUrl: "${winner.host}"`);
    log(
      `   useImpersonation: ${winner.transport === "cycletls" ? "true" : "false"}`
    );
    if (winner.transport === "cycletls" && winner.encoding) {
      log(
        `   (the module auto-negotiates this; the winning encoding was ` +
          `"${winner.encoding}")`
      );
    }
    log("   (leave email/password unset — this account can't password-login)");
    log("Then restart MagicMirror. Re-run this when the token expires.");
  } else {
    log("The token did not work on any host/transport. Either it's already");
    log("expired (grab a fresh one from the browser — README Option B) or the");
    log("data endpoints are Cloudflare-blocked for your setup too — see above.");
  }
}

function report(label, result) {
  log("");
  log(`── ${label} ─────────────────────────────`);
  if (result.skipped) {
    log(`   skipped: ${result.skipped}`);
    return null;
  }
  if (result.error) {
    log(`   transport error: ${result.error}`);
    return null;
  }
  const info = classify(result.status, result.headers, result.bodyText);
  log(`   status : ${result.status}`);
  log(`   server : ${info.server || "?"}`);
  if (info.cfRay) log(`   cf-ray : ${info.cfRay}`);
  if (info.cfMitigated) log(`   cf-mit : ${info.cfMitigated}`);
  if (result.encoding) log(`   accEnc : ${result.encoding}`);
  log(`   body   : ${bodyBrief(result.bodyText)}`);
  log(`   verdict: ${info.verdict}`);
  return info.success ? result : null;
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = argv.filter((a) => a.startsWith("--"));
  const args = argv.filter((a) => !a.startsWith("--"));

  // Token-test mode: `node diagnose.js --token` (or LIFE360_TOKEN=…).
  // Verifies a captured bearer token against the real data endpoint. This is
  // the right mode for accounts that sign in with an emailed code (no password
  // login is possible), where you capture a token from the browser (log in at
  // life360.com/login with DevTools open — see README Option B).
  const tokenMode = flags.includes("--token") || !!process.env.LIFE360_TOKEN;
  if (tokenMode) {
    let token = process.env.LIFE360_TOKEN;
    if (!token) {
      token = (await prompt("Paste captured Life360 access token: ")).trim();
    }
    // Accept a pasted "Bearer xxx" or a raw token.
    token = token.replace(/^Bearer\s+/i, "").trim();
    if (!token) {
      log("no token provided");
      process.exit(1);
    }
    await testToken(token);
    return;
  }

  let email = process.env.LIFE360_EMAIL || args[0];
  let password = process.env.LIFE360_PASSWORD;

  if (!email) email = (await prompt("Life360 email: ")).trim();
  if (!password) password = await prompt("Life360 password: ", { mask: true });
  if (!email || !password) {
    log("email and password are both required (or use --token; see README)");
    process.exit(1);
  }

  const headers = {
    Authorization: `Basic ${AUTH_TOKEN}`,
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    // Ask for an uncompressed body: cycletls doesn't auto-decode compression,
    // so a compressed reply would arrive as an empty 200. identity sidesteps it.
    "Accept-Encoding": "identity",
    "cache-control": "no-cache",
    "User-Agent": USER_AGENT
  };
  const bodyString = new URLSearchParams({
    grant_type: "password",
    username: email,
    password
  }).toString();

  log("Probing every transport × host combination…");

  let winner = null;
  for (const host of HOSTS) {
    const c = await tryCycle(host, bodyString, headers);
    winner = report(`cycletls  →  ${host}`, c) || winner;

    const f = await tryFetch(host, bodyString, headers);
    winner = report(`fetch     →  ${host}`, f) || winner;
  }

  log("");
  log("──────────── SUMMARY ────────────");
  if (winner) {
    log("At least one combination WORKED. In your config.js set the matching:");
    log("   useImpersonation: true  (if a cycletls row succeeded)");
    log("   baseUrl: \"<the host that succeeded>\"");
    log("Then restart MagicMirror. (Token not printed here — use get-token.js.)");
  } else {
    log("Nothing worked. Interpret the verdicts above:");
    log("   • All ⛔ CLOUDFLARE  → TLS blocking even via cycletls. Try a");
    log("     different ja3, or capture a token in the browser (README Option B).");
    log("   • Any 🔑 LIFE360 REJECTED → the request got THROUGH Cloudflare but");
    log("     the login was refused: check email/password, the authToken, or");
    log("     whether the account uses 2FA (then capture a token in the browser).");
    log("   • ⏳ RATE LIMITED → wait a while before trying again.");
  }
}

main().catch((err) => {
  log(err && err.message ? err.message : String(err));
  process.exit(1);
});
