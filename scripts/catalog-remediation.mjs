#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import {
  assertBulkInputSize,
  buildInventoryPlan,
  buildTitleChanges,
  selectRemediationProducts
} from "./lib/remediation-plan.mjs";
import { loadEnvFile } from "./lib/dotenv-file.mjs";
import { TerminalProgress } from "./lib/progress-ui.mjs";

const REQUIRED_STORE = "hpas5s-eu.myshopify.com";
const DEFAULT_API_VERSION = "2026-01";
const FIX_CONFIRMATION = "FIX_EXCLUSIVE_MOTORS_AU_CATALOG";
const DEFAULT_TARGET_QUANTITY = 10;
const DEFAULT_POLL_SECONDS = 20;

const TITLE_MUTATION = `
mutation productTitleRemediation($product: ProductUpdateInput!) {
  productUpdate(product: $product) {
    product {
      id
      title
    }
    userErrors {
      field
      message
    }
  }
}
`;

const INVENTORY_MUTATION = `
mutation inventoryRemediation($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
  inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
    inventoryAdjustmentGroup {
      createdAt
    }
    userErrors {
      field
      message
      code
    }
  }
}
`;

let activeUi = null;

function parseArgs(argv) {
  const args = {
    command: "run",
    runDir: null,
    applyLimit: null,
    targetQuantity: DEFAULT_TARGET_QUANTITY,
    locationId: "",
    pollSeconds: DEFAULT_POLL_SECONDS,
    confirmFix: "",
    noUi: false
  };

  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith("-")) args.command = rest.shift();

  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    const next = rest[i + 1];
    if (key === "--help" || key === "-h") args.command = "help";
    else if (key === "--run-dir") args.runDir = String(next), i += 1;
    else if (key === "--apply-limit") args.applyLimit = Number(next), i += 1;
    else if (key === "--target-quantity") args.targetQuantity = Number(next), i += 1;
    else if (key === "--location-id") args.locationId = String(next), i += 1;
    else if (key === "--poll-seconds") args.pollSeconds = Number(next), i += 1;
    else if (key === "--confirm-fix") args.confirmFix = String(next), i += 1;
    else if (key === "--no-ui") args.noUi = true;
    else throw new Error(`Unknown argument: ${key}`);
  }

  if (args.applyLimit !== null && (!Number.isInteger(args.applyLimit) || args.applyLimit < 1)) {
    throw new Error("--apply-limit must be a positive integer");
  }
  if (!Number.isInteger(args.targetQuantity) || args.targetQuantity < 0) {
    throw new Error("--target-quantity must be a non-negative integer");
  }
  if (!Number.isInteger(args.pollSeconds) || args.pollSeconds < 1) {
    throw new Error("--poll-seconds must be a positive integer");
  }
  if (!args.runDir) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    args.runDir = join(process.cwd(), "catalog-runs", `remediation-${stamp}`);
  }

  return args;
}

function printHelp() {
  console.log(`
Usage:
  node scripts/catalog-remediation.mjs run [options]

Options:
  --run-dir <path>          Output directory for remediation artifacts
  --apply-limit <number>    Apply to at most this many products, prioritizing bad titles
  --target-quantity <n>     Available inventory quantity to set (default: ${DEFAULT_TARGET_QUANTITY})
  --location-id <gid>       Shopify location ID; auto-detects the only online location when omitted
  --poll-seconds <number>   Bulk operation polling interval (default: ${DEFAULT_POLL_SECONDS})
  --confirm-fix <text>      Must equal ${FIX_CONFIRMATION} to mutate
  --no-ui                   Disable the terminal progress dashboard

Environment:
  SHOPIFY_ADMIN_API_DOMAIN must be ${REQUIRED_STORE}
  SHOPIFY_ADMIN_API_ACCESS_TOKEN must be set
  SHOPIFY_ADMIN_API_VERSION defaults to ${DEFAULT_API_VERSION}
`);
}

function getConfig() {
  const shop = process.env.SHOPIFY_ADMIN_API_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
  const apiVersion = process.env.SHOPIFY_ADMIN_API_VERSION || DEFAULT_API_VERSION;

  if (!shop) throw new Error("SHOPIFY_ADMIN_API_DOMAIN is not set");
  if (shop !== REQUIRED_STORE) throw new Error(`Refusing to run against ${shop}; expected ${REQUIRED_STORE}`);
  if (!token) throw new Error("SHOPIFY_ADMIN_API_ACCESS_TOKEN is not set");

  return {
    shop,
    token,
    apiVersion,
    endpoint: `https://${shop}/admin/api/${apiVersion}/graphql.json`
  };
}

async function shopifyGraphql(config, query, variables = {}) {
  const response = await fetch(config.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": config.token
    },
    body: JSON.stringify({ query, variables })
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Shopify HTTP ${response.status}: ${JSON.stringify(json)}`);
  if (json?.errors?.length) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json;
}

async function getShopSnapshot(config) {
  const query = `
    query ShopSnapshot {
      shop {
        name
        myshopifyDomain
        primaryDomain {
          url
          host
        }
      }
      productsCount {
        count
        precision
      }
    }
  `;
  const json = await shopifyGraphql(config, query);
  return json.data;
}

async function resolveLocationId(config, requestedLocationId) {
  if (requestedLocationId) return requestedLocationId;
  const query = `
    query Locations {
      locations(first: 20, includeInactive: false) {
        nodes {
          id
          name
          isActive
          fulfillsOnlineOrders
        }
      }
    }
  `;
  const json = await shopifyGraphql(config, query);
  const candidates = json.data.locations.nodes.filter((location) => location.isActive && location.fulfillsOnlineOrders);
  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one active online fulfillment location, found ${candidates.length}`);
  }
  return candidates[0].id;
}

async function fetchProducts(config, locationId, ui) {
  const query = `
    query RemediationProducts($first: Int!, $after: String, $locationId: ID!) {
      products(first: $first, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          handle
          title
          variants(first: 100) {
            pageInfo {
              hasNextPage
            }
            nodes {
              id
              sku
              inventoryItem {
                id
                tracked
                inventoryLevel(locationId: $locationId) {
                  location {
                    id
                  }
                  quantities(names: ["available"]) {
                    name
                    quantity
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const products = [];
  let after = null;
  do {
    const json = await shopifyGraphql(config, query, { first: 250, after, locationId });
    const page = json.data.products;
    for (const product of page.nodes) {
      if (product.variants.pageInfo.hasNextPage) {
        throw new Error(`Product ${product.id} has more than 100 variants; runner needs variant pagination before applying`);
      }
      product.variants = product.variants.nodes;
      products.push(product);
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    if (products.length % 1000 === 0 || !after) {
      ui.update({
        stage: "Fetch products",
        status: "RUNNING",
        done: products.length,
        total: null,
        unit: "products",
        detail: "Reading retained catalog state"
      });
    }
  } while (after);

  return products;
}

async function writeSnapshot(path, products) {
  const stream = createWriteStream(path);
  for (const product of products) stream.write(`${JSON.stringify(product)}\n`);
  await closeStream(stream);
}

async function writeCsv(path, headers, rows) {
  const stream = createWriteStream(path);
  stream.write(`${headers.join(",")}\n`);
  for (const row of rows) {
    stream.write(`${headers.map((header) => csvCell(row[header] ?? "")).join(",")}\n`);
  }
  await closeStream(stream);
}

async function writeJsonl(path, rows) {
  const stream = createWriteStream(path);
  for (const row of rows) stream.write(`${JSON.stringify(row)}\n`);
  await closeStream(stream);
}

function csvCell(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function titleCsvRows(changes) {
  return changes.map((change) => ({
    product_id: change.productId,
    handle: change.handle,
    before_title: change.beforeTitle,
    after_title: change.afterTitle
  }));
}

function inventoryCsvRows(changes, status = "") {
  return changes.map((change) => ({
    product_id: change.productId,
    product_title: change.productTitle,
    variant_id: change.variantId,
    sku: change.sku,
    inventory_item_id: change.inventoryItemId,
    location_id: change.locationId,
    before_quantity: change.beforeQuantity,
    target_quantity: change.targetQuantity,
    status
  }));
}

async function gzipFile(input, output) {
  await pipeline(createReadStream(input), createGzip(), createWriteStream(output));
}

async function stagedUpload(config, jsonlPath) {
  const filename = basename(jsonlPath);
  const query = `
    mutation CreateBulkMutationStagedUpload($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          parameters {
            name
            value
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;
  const json = await shopifyGraphql(config, query, {
    input: [{
      resource: "BULK_MUTATION_VARIABLES",
      filename,
      mimeType: "text/jsonl",
      httpMethod: "POST"
    }]
  });
  const payload = json.data.stagedUploadsCreate;
  if (payload.userErrors.length) throw new Error(`stagedUploadsCreate failed: ${JSON.stringify(payload.userErrors)}`);

  const target = payload.stagedTargets[0];
  const form = new FormData();
  for (const param of target.parameters) form.append(param.name, param.value);
  const buffer = await readFile(jsonlPath);
  form.append("file", new Blob([buffer], { type: "text/jsonl" }), filename);

  const upload = await fetch(target.url, { method: "POST", body: form });
  if (!upload.ok) throw new Error(`Staged upload failed: HTTP ${upload.status} ${await upload.text()}`);

  const key = target.parameters.find((param) => param.name === "key")?.value;
  if (!key) throw new Error("Staged upload response did not include a key parameter");
  return key;
}

async function startBulkMutation(config, mutation, stagedUploadPath, clientIdentifier) {
  const query = `
    mutation StartBulkMutation($mutation: String!, $stagedUploadPath: String!, $clientIdentifier: String) {
      bulkOperationRunMutation(
        mutation: $mutation,
        stagedUploadPath: $stagedUploadPath,
        clientIdentifier: $clientIdentifier
      ) {
        bulkOperation {
          id
          status
          type
          createdAt
        }
        userErrors {
          field
          message
        }
      }
    }
  `;
  const json = await shopifyGraphql(config, query, { mutation, stagedUploadPath, clientIdentifier });
  const payload = json.data.bulkOperationRunMutation;
  if (payload.userErrors.length) throw new Error(`bulkOperationRunMutation failed: ${JSON.stringify(payload.userErrors)}`);
  return payload.bulkOperation;
}

async function getBulkOperation(config, id) {
  const query = `
    query BulkOperation($id: ID!) {
      node(id: $id) {
        ... on BulkOperation {
          id
          type
          status
          errorCode
          createdAt
          completedAt
          objectCount
          rootObjectCount
          fileSize
          url
          partialDataUrl
        }
      }
    }
  `;
  const json = await shopifyGraphql(config, query, { id });
  return json.data.node;
}

async function pollBulkOperation(config, id, pollSeconds, ui, stage, total) {
  for (;;) {
    const operation = await getBulkOperation(config, id);
    ui.update({
      stage,
      status: operation.status,
      done: Number(operation.objectCount || 0),
      total,
      unit: "rows",
      detail: operation.errorCode ? `error=${operation.errorCode}` : operation.id
    });
    if (operation.status === "COMPLETED") return operation;
    if (["FAILED", "CANCELED", "CANCELING", "EXPIRED"].includes(operation.status)) {
      throw new Error(`${stage} bulk operation ${operation.id} ended with ${operation.status}: ${operation.errorCode || "no error code"}`);
    }
    await sleep(pollSeconds * 1000);
  }
}

async function runBulkJob(config, job, pollSeconds, ui) {
  const stagedUploadPath = await stagedUpload(config, job.inputPath);
  const started = await startBulkMutation(config, job.mutation, stagedUploadPath, job.clientIdentifier);
  const completed = await pollBulkOperation(config, started.id, pollSeconds, ui, job.stage, job.expectedRows);
  if (completed.url) await downloadToFile(completed.url, job.resultsPath);
  return { stagedUploadPath, started, completed };
}

async function downloadToFile(url, path) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  await pipeline(response.body, createWriteStream(path));
}

async function summarizeResultErrors(path, mutationName) {
  const content = await readFile(path, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const errors = [];
  if (!content.trim()) return errors;
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const item = JSON.parse(line);
    const userErrors = item.data?.[mutationName]?.userErrors || [];
    for (const error of userErrors) {
      errors.push({ lineNumber: item.__lineNumber, ...error });
    }
  }
  return errors;
}

async function verifyProducts(config, products, inventoryChanges, locationId, targetQuantity) {
  const expectedTitles = new Map(buildTitleChanges(products).map((change) => [change.productId, change.afterTitle]));
  const expectedInventory = new Map();
  for (const change of inventoryChanges) expectedInventory.set(change.variantId, { productId: change.productId, quantity: targetQuantity });

  const ids = products.map((product) => product.id);
  const failures = { titles: [], inventory: [] };
  for (let index = 0; index < ids.length; index += 100) {
    const chunk = ids.slice(index, index + 100);
    const query = `
      query VerifyProducts($ids: [ID!]!, $locationId: ID!) {
        nodes(ids: $ids) {
          ... on Product {
            id
            title
            variants(first: 100) {
              nodes {
                id
                inventoryItem {
                  inventoryLevel(locationId: $locationId) {
                    quantities(names: ["available"]) {
                      name
                      quantity
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;
    const json = await shopifyGraphql(config, query, { ids: chunk, locationId });
    for (const product of json.data.nodes.filter(Boolean)) {
      const expectedTitle = expectedTitles.get(product.id);
      if (expectedTitle && product.title !== expectedTitle) {
        failures.titles.push({ productId: product.id, expected: expectedTitle, actual: product.title });
      }
      for (const variant of product.variants.nodes) {
        if (!expectedInventory.has(variant.id)) continue;
        const quantity = variant.inventoryItem?.inventoryLevel?.quantities?.find((item) => item.name === "available")?.quantity;
        if (quantity !== targetQuantity) {
          failures.inventory.push({ productId: product.id, variantId: variant.id, expected: targetQuantity, actual: quantity ?? null });
        }
      }
    }
  }
  return failures;
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function fileInfo(path) {
  const info = await stat(path);
  return { bytes: info.size, sha256: await hashFile(path) };
}

async function writeManifest(runDir, manifest) {
  await writeFile(join(runDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function closeStream(stream) {
  await new Promise((resolve, reject) => {
    stream.end(resolve);
    stream.on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  await loadEnvFile();
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help") {
    printHelp();
    return;
  }
  if (args.command !== "run") throw new Error(`Unsupported command: ${args.command}`);

  const config = getConfig();
  const ui = new TerminalProgress({ title: "Exclusive Motors AU Catalog Remediation", enabled: !args.noUi });
  activeUi = ui;
  await mkdir(args.runDir, { recursive: true });

  const paths = {
    snapshot: join(args.runDir, "remediation-export.jsonl"),
    snapshotGz: join(args.runDir, "remediation-export.jsonl.gz"),
    titleCsv: join(args.runDir, "title-changes.csv"),
    titleInput: join(args.runDir, "title-mutation-input.jsonl"),
    titleResults: join(args.runDir, "title-mutation-results.jsonl"),
    inventoryCsv: join(args.runDir, "inventory-changes.csv"),
    inventorySkippedCsv: join(args.runDir, "inventory-skipped.csv"),
    inventoryInput: join(args.runDir, "inventory-mutation-input.jsonl"),
    inventoryResults: join(args.runDir, "inventory-mutation-results.jsonl")
  };

  const locationId = await resolveLocationId(config, args.locationId);
  const manifest = {
    started_at: new Date().toISOString(),
    shop: config.shop,
    api_version: config.apiVersion,
    run_dir: args.runDir,
    location_id: locationId,
    target_quantity: args.targetQuantity,
    apply_limit: args.applyLimit,
    mutation_confirmed: args.confirmFix === FIX_CONFIRMATION,
    files: {},
    counts: {},
    operations: {},
    errors: {}
  };

  manifest.shop_snapshot_before = await getShopSnapshot(config);
  await writeManifest(args.runDir, manifest);

  ui.update({ stage: "Fetch products", status: "RUNNING", done: 0, total: null, unit: "products", detail: "Reading retained catalog state" });
  const allProducts = await fetchProducts(config, locationId, ui);
  const selectedProducts = selectRemediationProducts(allProducts, args.applyLimit);

  ui.update({ stage: "Write plan", status: "RUNNING", done: 0, total: selectedProducts.length, unit: "products", detail: "Writing remediation artifacts" });
  await writeSnapshot(paths.snapshot, selectedProducts);
  await gzipFile(paths.snapshot, paths.snapshotGz);

  const titleChanges = buildTitleChanges(selectedProducts);
  const inventoryPlan = buildInventoryPlan(selectedProducts, {
    locationId,
    targetQuantity: args.targetQuantity,
    runId: basename(args.runDir).replace(/[^a-zA-Z0-9_.-]/g, "-")
  });

  await writeCsv(paths.titleCsv, ["product_id", "handle", "before_title", "after_title"], titleCsvRows(titleChanges));
  await writeJsonl(paths.titleInput, titleChanges.map((change) => change.variables));
  await writeCsv(
    paths.inventoryCsv,
    ["product_id", "product_title", "variant_id", "sku", "inventory_item_id", "location_id", "before_quantity", "target_quantity", "status"],
    inventoryCsvRows(inventoryPlan.changes, "planned")
  );
  await writeCsv(
    paths.inventorySkippedCsv,
    ["product_id", "product_title", "variant_id", "sku", "inventory_item_id", "reason"],
    inventoryPlan.skipped.map((row) => ({
      product_id: row.productId,
      product_title: row.productTitle,
      variant_id: row.variantId,
      sku: row.sku,
      inventory_item_id: row.inventoryItemId,
      reason: row.reason
    }))
  );
  await writeJsonl(paths.inventoryInput, inventoryPlan.batches.map((batch) => batch.variables));

  for (const path of Object.values(paths)) {
    if (path.endsWith("results.jsonl")) continue;
    manifest.files[basename(path)] = await fileInfo(path);
  }
  assertBulkInputSize(manifest.files[basename(paths.titleInput)].bytes);
  assertBulkInputSize(manifest.files[basename(paths.inventoryInput)].bytes);
  manifest.counts = {
    products_seen: allProducts.length,
    products_selected: selectedProducts.length,
    title_changes: titleChanges.length,
    inventory_changes: inventoryPlan.changes.length,
    inventory_skipped: inventoryPlan.skipped.length
  };
  manifest.planned_at = new Date().toISOString();
  await writeManifest(args.runDir, manifest);

  if (args.confirmFix !== FIX_CONFIRMATION) {
    ui.complete(`[stop] remediation not applied. Pass --confirm-fix ${FIX_CONFIRMATION} after reviewing artifacts.`);
    return;
  }

  const jobs = [];
  if (titleChanges.length) {
    jobs.push({
      name: "title",
      inputPath: paths.titleInput,
      resultsPath: paths.titleResults,
      mutation: TITLE_MUTATION,
      clientIdentifier: "exclusive-motors-au-title-remediation",
      stage: "Title bulk update",
      expectedRows: titleChanges.length
    });
  }
  if (inventoryPlan.changes.length) {
    jobs.push({
      name: "inventory",
      inputPath: paths.inventoryInput,
      resultsPath: paths.inventoryResults,
      mutation: INVENTORY_MUTATION,
      clientIdentifier: "exclusive-motors-au-inventory-remediation",
      stage: "Inventory bulk update",
      expectedRows: inventoryPlan.changes.length
    });
  }

  const results = await Promise.all(jobs.map(async (job) => [job.name, await runBulkJob(config, job, args.pollSeconds, ui)]));
  for (const [name, result] of results) {
    manifest.operations[name] = result;
    const resultPath = name === "title" ? paths.titleResults : paths.inventoryResults;
    manifest.files[basename(resultPath)] = await fileInfo(resultPath);
  }

  manifest.errors.title = await summarizeResultErrors(paths.titleResults, "productUpdate");
  manifest.errors.inventory = await summarizeResultErrors(paths.inventoryResults, "inventorySetQuantities");
  manifest.verification = await verifyProducts(config, selectedProducts, inventoryPlan.changes, locationId, args.targetQuantity);
  manifest.shop_snapshot_after = await getShopSnapshot(config);
  manifest.completed_at = new Date().toISOString();
  await writeManifest(args.runDir, manifest);

  const errorCount = manifest.errors.title.length + manifest.errors.inventory.length +
    manifest.verification.titles.length + manifest.verification.inventory.length;
  if (errorCount > 0) throw new Error(`Remediation completed with ${errorCount} result or verification errors; see manifest.json`);
  ui.complete(`[done] remediated products=${selectedProducts.length} title_changes=${titleChanges.length} inventory_changes=${inventoryPlan.changes.length}`);
}

main().catch((error) => {
  activeUi?.close();
  console.error(`[error] ${error.message}`);
  process.exitCode = 1;
});
