#!/usr/bin/env node

import { loadEnvFile } from "./lib/dotenv-file.mjs";

const REQUIRED_STORE = "hpas5s-eu.myshopify.com";
const DEFAULT_API_VERSION = "2026-01";

await loadEnvFile();

const command = process.argv[2] || "status";
const shop = process.env.SHOPIFY_ADMIN_API_DOMAIN || REQUIRED_STORE;
const token = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const apiVersion = process.env.SHOPIFY_ADMIN_API_VERSION || DEFAULT_API_VERSION;

if (shop !== REQUIRED_STORE) throw new Error(`Refusing to run against ${shop}; expected ${REQUIRED_STORE}`);
if (!token) throw new Error("SHOPIFY_ADMIN_API_ACCESS_TOKEN is not set");

const endpoint = `https://${shop}/admin/api/${apiVersion}/graphql.json`;
const operation = await currentBulkOperation();

if (!operation) {
  console.log("[bulk] no current bulk operation");
  process.exit(0);
}

console.log(`[bulk] ${operation.status} ${operation.type} id=${operation.id} root=${operation.rootObjectCount} objects=${operation.objectCount}`);

if (command === "cancel") {
  const result = await graphql(
    `mutation CancelBulkOperation($id: ID!) {
      bulkOperationCancel(id: $id) {
        bulkOperation {
          id
          status
        }
        userErrors {
          field
          message
        }
      }
    }`,
    { id: operation.id }
  );
  const payload = result.bulkOperationCancel;
  if (payload.userErrors.length) throw new Error(`bulkOperationCancel failed: ${JSON.stringify(payload.userErrors)}`);
  console.log(`[bulk] cancel requested: ${payload.bulkOperation.status}`);
} else if (command !== "status") {
  throw new Error("Usage: node scripts/bulk-status.mjs [status|cancel]");
}

async function currentBulkOperation() {
  const data = await graphql(`
    query CurrentBulkOperation {
      currentBulkOperation {
        id
        status
        type
        rootObjectCount
        objectCount
      }
    }
  `);
  return data.currentBulkOperation;
}

async function graphql(query, variables = {}) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token
    },
    body: JSON.stringify({ query, variables })
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Shopify HTTP ${response.status}: ${JSON.stringify(json)}`);
  if (json?.errors?.length) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}
