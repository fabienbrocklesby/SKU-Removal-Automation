#!/usr/bin/env node

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

import { loadEnvFile, upsertEnvBlock } from "./lib/dotenv-file.mjs";

const REQUIRED_STORE = "hpas5s-eu.myshopify.com";
const DEFAULT_API_VERSION = "2026-01";
const DEFAULT_REDIRECT_URI = "http://localhost:8765/callback";
const DEFAULT_SCOPES = [
  "read_inventory",
  "write_inventory",
  "read_locations",
  "read_products",
  "write_products",
  "read_publications",
  "write_publications"
].join(",");

await loadEnvFile();

const args = parseArgs(process.argv.slice(2));
if (args.command === "help") {
  printHelp();
} else if (args.command === "url") {
  const config = getOauthConfig(false);
  console.log(buildAuthUrl(config));
} else if (args.command === "exchange") {
  const config = getOauthConfig(true);
  const code = args.code || process.env.SHOPIFY_OAUTH_CODE;
  if (!code) throw new Error("Provide --code <temporary OAuth code>");
  const token = await exchangeCode(config, code);
  await saveToken(config, token);
} else if (args.command === "listen") {
  const config = getOauthConfig(true);
  await listenForToken(config, { openBrowser: args.openBrowser });
} else {
  throw new Error(`Unsupported command: ${args.command}`);
}

function parseArgs(argv) {
  const parsed = {
    command: argv[0] && !argv[0].startsWith("-") ? argv[0] : "help",
    code: "",
    openBrowser: true
  };

  for (let i = parsed.command === "help" && argv[0]?.startsWith("-") ? 0 : 1; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === "--help" || key === "-h") parsed.command = "help";
    else if (key === "--code") parsed.code = String(next), i += 1;
    else if (key === "--no-open") parsed.openBrowser = false;
    else throw new Error(`Unknown argument: ${key}`);
  }

  return parsed;
}

function printHelp() {
  console.log(`
Usage:
  node scripts/oauth-token.mjs url
  node scripts/oauth-token.mjs listen [--no-open]
  node scripts/oauth-token.mjs exchange --code <code>

Environment or .env:
  SHOPIFY_APP_CLIENT_ID       Shopify app client ID
  SHOPIFY_APP_CLIENT_SECRET   Shopify app client secret
  SHOPIFY_ADMIN_API_DOMAIN    Defaults to ${REQUIRED_STORE}
  SHOPIFY_OAUTH_REDIRECT_URI  Defaults to ${DEFAULT_REDIRECT_URI}

The token is saved to .env as SHOPIFY_ADMIN_API_ACCESS_TOKEN and is masked in output.
`);
}

function getOauthConfig(requireSecret) {
  const shop = process.env.SHOPIFY_ADMIN_API_DOMAIN || REQUIRED_STORE;
  const clientId = process.env.SHOPIFY_APP_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_APP_CLIENT_SECRET;
  const redirectUri = process.env.SHOPIFY_OAUTH_REDIRECT_URI || DEFAULT_REDIRECT_URI;
  const scopes = process.env.SHOPIFY_OAUTH_SCOPES || DEFAULT_SCOPES;

  if (shop !== REQUIRED_STORE) {
    throw new Error(`Refusing to authenticate ${shop}; expected ${REQUIRED_STORE}`);
  }
  if (!clientId) throw new Error("SHOPIFY_APP_CLIENT_ID is not set");
  if (requireSecret && !clientSecret) throw new Error("SHOPIFY_APP_CLIENT_SECRET is not set");

  return { shop, clientId, clientSecret, redirectUri, scopes };
}

function buildAuthUrl(config) {
  const url = new URL(`https://${config.shop}/admin/oauth/authorize`);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("scope", config.scopes);
  url.searchParams.set("redirect_uri", config.redirectUri);
  return url.toString();
}

async function listenForToken(config, options) {
  const redirect = new URL(config.redirectUri);
  const port = Number(redirect.port || 80);
  const host = redirect.hostname === "localhost" ? "127.0.0.1" : redirect.hostname;
  const authUrl = buildAuthUrl(config);

  console.log(`[oauth] waiting for Shopify callback on ${config.redirectUri}`);
  console.log(`[oauth] authorization URL: ${authUrl}`);
  if (options.openBrowser) openUrl(authUrl);

  const code = await new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url, config.redirectUri);
      if (requestUrl.pathname !== redirect.pathname) {
        response.writeHead(404).end("Not found");
        return;
      }

      const error = requestUrl.searchParams.get("error_description") || requestUrl.searchParams.get("error");
      const codeParam = requestUrl.searchParams.get("code");

      if (error || !codeParam) {
        response.writeHead(400, { "Content-Type": "text/html" });
        response.end(`<h2>Authorization failed</h2><p>${escapeHtml(error || "No code returned")}</p>`);
        server.close();
        reject(new Error(error || "No code returned"));
        return;
      }

      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<h2>Authorization successful.</h2><p>You can close this tab.</p>");
      server.close();
      resolve(codeParam);
    });

    server.on("error", reject);
    server.listen(port, host);
  });

  const token = await exchangeCode(config, code);
  await saveToken(config, token);
}

async function exchangeCode(config, code) {
  console.log("[oauth] exchanging temporary code for offline Admin API token");
  const response = await fetch(`https://${config.shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code
    })
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`OAuth exchange failed HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  if (!payload?.access_token) {
    throw new Error(`OAuth exchange did not return access_token: ${JSON.stringify(payload)}`);
  }

  return {
    accessToken: payload.access_token,
    scopes: payload.scope || ""
  };
}

async function saveToken(config, token) {
  let current = "";
  try {
    current = await readFile(".env", "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const next = upsertEnvBlock(current, {
    SHOPIFY_ADMIN_API_DOMAIN: config.shop,
    SHOPIFY_ADMIN_API_ACCESS_TOKEN: token.accessToken,
    SHOPIFY_ADMIN_API_VERSION: process.env.SHOPIFY_ADMIN_API_VERSION || DEFAULT_API_VERSION,
    SHOPIFY_APP_CLIENT_ID: config.clientId,
    SHOPIFY_APP_CLIENT_SECRET: config.clientSecret,
    SHOPIFY_OAUTH_REDIRECT_URI: config.redirectUri
  });

  await writeFile(".env", next, { mode: 0o600 });
  console.log(`[oauth] saved token to .env as SHOPIFY_ADMIN_API_ACCESS_TOKEN (${mask(token.accessToken)})`);
  console.log(`[oauth] granted scopes: ${token.scopes || "not returned"}`);
}

function openUrl(url) {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(opener, [url], { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

function mask(value) {
  if (!value || value.length <= 12) return "[set]";
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
