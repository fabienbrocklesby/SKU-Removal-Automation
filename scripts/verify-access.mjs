#!/usr/bin/env node

import { loadEnvFile } from "./lib/dotenv-file.mjs";

const REQUIRED_STORE = "hpas5s-eu.myshopify.com";
const DEFAULT_API_VERSION = "2026-01";
const REQUIRED_SCOPES = ["read_products", "write_products"];

await loadEnvFile();

const shop = process.env.SHOPIFY_ADMIN_API_DOMAIN || REQUIRED_STORE;
const token = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const apiVersion = process.env.SHOPIFY_ADMIN_API_VERSION || DEFAULT_API_VERSION;

if (shop !== REQUIRED_STORE) {
  throw new Error(`Refusing to verify ${shop}; expected ${REQUIRED_STORE}`);
}
if (!token) {
  throw new Error("SHOPIFY_ADMIN_API_ACCESS_TOKEN is not set. Run bin/catalog oauth first.");
}

const endpoint = `https://${shop}/admin/api/${apiVersion}/graphql.json`;
const query = `
  query VerifyCatalogCleanupAccess {
    shop {
      name
      myshopifyDomain
      primaryDomain {
        host
        url
      }
    }
    productsCount {
      count
      precision
    }
    currentAppInstallation {
      accessScopes {
        handle
      }
    }
  }
`;

const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": token
  },
  body: JSON.stringify({ query })
});

const json = await response.json().catch(() => null);
if (!response.ok) {
  throw new Error(`Shopify HTTP ${response.status}: ${JSON.stringify(json)}`);
}
if (json?.errors?.length) {
  throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
}

const data = json.data;
if (data.shop.myshopifyDomain !== REQUIRED_STORE) {
  throw new Error(`Token belongs to ${data.shop.myshopifyDomain}; expected ${REQUIRED_STORE}`);
}

const scopes = data.currentAppInstallation.accessScopes.map((scope) => scope.handle);
const missingScopes = REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope));
if (missingScopes.length) {
  throw new Error(`Token is missing required scopes: ${missingScopes.join(", ")}`);
}

console.log(`[ok] ${data.shop.name} ${data.shop.myshopifyDomain}`);
console.log(`[ok] primary domain: ${data.shop.primaryDomain?.host || "unknown"}`);
console.log(`[ok] products: ${data.productsCount.count} (${data.productsCount.precision})`);
console.log(`[ok] scopes: ${scopes.join(", ")}`);
console.log(`[ok] token: ${mask(token)}`);

function mask(value) {
  if (value.length <= 12) return "[set]";
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}
