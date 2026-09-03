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

const MODULE_NAME = "MMM-Life360";
const BASE_URL = "https://api-cloudfront.life360.com";
const TOKEN_PATH = "/v3/oauth2/token";
const USER_AGENT = "com.life360.android.safetymapd/KOKO/23.49.0 android/13";
// Long-standing community client token; override with LIFE360_AUTH_TOKEN.
const AUTH_TOKEN =
  process.env.LIFE360_AUTH_TOKEN ||
  "cSgLxOgW7Jm7AbNa16Ki7lhCUcUhCz2Uv6EWt66zBrIZ0Wz7DKZ0lStY1vAP1nA7EObZ8i";

const CACHE_FILE = path.join(__dirname, ".life360-token.json");

function log(msg) {
  console.error(`[${MODULE_NAME}] ${msg}`); // logs go to stderr...
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

async function login(email, password) {
  if (typeof fetch !== "function") {
    throw new Error("global fetch is unavailable — Node 18+ is required");
  }

  log("authenticating with Life360 (password grant)…");
  const body = new URLSearchParams({
    grant_type: "password",
    username: email,
    password
  });

  const res = await fetch(`${BASE_URL}${TOKEN_PATH}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${AUTH_TOKEN}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "cache-control": "no-cache",
      "User-Agent": USER_AGENT
    },
    body
  });

  const text = await res.text();
  if (!res.ok) {
    let hint = "";
    if (res.status === 403) {
      hint =
        "\n  → 403 usually means Cloudflare bot-protection, 2FA on the " +
        "account, or a datacenter/VPN IP.\n" +
        "    Try from a residential connection, or capture a token from the " +
        "app (see README).";
    }
    throw new Error(
      `authentication failed (${res.status} ${res.statusText})${hint}\n  ${text.slice(
        0,
        300
      )}`
    );
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`could not parse token response: ${text.slice(0, 200)}`);
  }
  if (!data.access_token) {
    throw new Error("authentication succeeded but no access_token was returned");
  }
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
