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
 * Usage:
 *   node diagnose.js                      # prompts for email + password
 *   node diagnose.js you@example.com
 *   LIFE360_EMAIL=... LIFE360_PASSWORD=... node diagnose.js
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

  let verdict;
  if (status >= 200 && status < 300) {
    verdict = "✅ SUCCESS";
  } else if (status === 403 && looksCloudflare) {
    verdict = "⛔ CLOUDFLARE BLOCK (TLS fingerprint) — token won't help";
  } else if (status === 403) {
    verdict = "🔑 LIFE360 REJECTED (credentials / authToken / 2FA)";
  } else if (status === 401) {
    verdict = "🔑 UNAUTHORIZED (bad credentials or client token)";
  } else if (status === 429) {
    verdict = "⏳ RATE LIMITED — back off and retry later";
  } else {
    verdict = `⚠️  unexpected status ${status}`;
  }

  return { server, cfRay, cfMitigated, verdict };
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
  log(`   body   : ${bodyBrief(result.bodyText)}`);
  log(`   verdict: ${info.verdict}`);
  return info.verdict.startsWith("✅") ? result : null;
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  let email = process.env.LIFE360_EMAIL || args[0];
  let password = process.env.LIFE360_PASSWORD;

  if (!email) email = (await prompt("Life360 email: ")).trim();
  if (!password) password = await prompt("Life360 password: ", { mask: true });
  if (!email || !password) {
    log("email and password are both required");
    process.exit(1);
  }

  const headers = {
    Authorization: `Basic ${AUTH_TOKEN}`,
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
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
    log("     different ja3, or capture a token from the app (README Option B).");
    log("   • Any 🔑 LIFE360 REJECTED → the request got THROUGH Cloudflare but");
    log("     the login was refused: check email/password, the authToken, or");
    log("     whether the account uses 2FA (then use app capture).");
    log("   • ⏳ RATE LIMITED → wait a while before trying again.");
  }
}

main().catch((err) => {
  log(err && err.message ? err.message : String(err));
  process.exit(1);
});
