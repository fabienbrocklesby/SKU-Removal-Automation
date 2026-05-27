#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import { chooseKeepProductIds, partitionProductsForDeletion } from "./lib/catalog-selection.mjs";
import { loadEnvFile } from "./lib/dotenv-file.mjs";

const REQUIRED_STORE = "hpas5s-eu.myshopify.com";
const DEFAULT_API_VERSION = "2026-01";
const DELETE_CONFIRMATION = "DELETE_EXCLUSIVE_MOTORS_AU_PRODUCTS";

const SHOPIFY_CSV_HEADERS = [
  "Handle",
  "Title",
  "Body (HTML)",
  "Vendor",
  "Product Category",
  "Type",
  "Tags",
  "Published",
  "Option1 Name",
  "Option1 Value",
  "Option2 Name",
  "Option2 Value",
  "Option3 Name",
  "Option3 Value",
  "Variant SKU",
  "Variant Grams",
  "Variant Inventory Tracker",
  "Variant Inventory Qty",
  "Variant Inventory Policy",
  "Variant Fulfillment Service",
  "Variant Price",
  "Variant Compare At Price",
  "Variant Requires Shipping",
  "Variant Taxable",
  "Variant Barcode",
  "Image Src",
  "Image Position",
  "Image Alt Text",
  "Gift Card",
  "SEO Title",
  "SEO Description",
  "Status"
];

const DELETED_SKU_HEADERS = [
  "product_id",
  "product_handle",
  "product_title",
  "variant_id",
  "variant_title",
  "sku",
  "barcode",
  "vendor",
  "product_type",
  "status_before_delete",
  "price",
  "compare_at_price",
  "inventory_item_id",
  "image_urls",
  "deleted_at"
];

const PRODUCT_DELETE_MUTATION = `
mutation productDeleteBulk($input: ProductDeleteInput!) {
  productDelete(input: $input) {
    deletedProductId
    userErrors {
      field
      message
    }
  }
}
`;

const BULK_PRODUCTS_QUERY = `
{
  products {
    edges {
      node {
        __typename
        id
        legacyResourceId
        title
        handle
        descriptionHtml
        vendor
        productType
        status
        tags
        createdAt
        updatedAt
        publishedAt
        onlineStoreUrl
        totalInventory
        tracksInventory
        seo {
          title
          description
        }
        options {
          id
          name
          position
          values
        }
        variants {
          edges {
            node {
              __typename
              id
              legacyResourceId
              title
              sku
              barcode
              price
              compareAtPrice
              inventoryPolicy
              taxable
              selectedOptions {
                name
                value
              }
              inventoryItem {
                id
                requiresShipping
                tracked
                unitCost {
                  amount
                  currencyCode
                }
              }
            }
          }
        }
        media {
          edges {
            node {
              __typename
              id
              alt
              mediaContentType
              status
              preview {
                image {
                  url
                }
              }
              ... on MediaImage {
                image {
                  url
                  altText
                }
              }
              ... on Video {
                sources {
                  url
                  mimeType
                }
              }
              ... on ExternalVideo {
                originUrl
              }
              ... on Model3d {
                sources {
                  url
                  mimeType
                }
              }
            }
          }
        }
        metafields {
          edges {
            node {
              __typename
              id
              namespace
              key
              value
              type
            }
          }
        }
      }
    }
  }
}
`;

function parseArgs(argv) {
  const args = {
    command: "run",
    keep: 10000,
    seed: "exclusive-motors-au-2026-05-27",
    pollSeconds: 20,
    runDir: null,
    skipExport: false,
    deleteLimit: null,
    sampleProducts: null,
    confirmDelete: "",
    directDeleteFallback: false
  };

  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith("-")) {
    args.command = rest.shift();
  }

  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    const next = rest[i + 1];
    if (key === "--help" || key === "-h") args.command = "help";
    else if (key === "--keep") args.keep = Number(next), i += 1;
    else if (key === "--seed") args.seed = String(next), i += 1;
    else if (key === "--run-dir") args.runDir = String(next), i += 1;
    else if (key === "--poll-seconds") args.pollSeconds = Number(next), i += 1;
    else if (key === "--delete-limit") args.deleteLimit = Number(next), i += 1;
    else if (key === "--sample-products") args.sampleProducts = Number(next), i += 1;
    else if (key === "--skip-export") args.skipExport = true;
    else if (key === "--direct-delete-fallback") args.directDeleteFallback = true;
    else if (key === "--confirm-delete") args.confirmDelete = String(next), i += 1;
    else throw new Error(`Unknown argument: ${key}`);
  }

  if (!Number.isInteger(args.keep) || args.keep < 1) {
    throw new Error("--keep must be a positive integer");
  }
  if (args.deleteLimit !== null && (!Number.isInteger(args.deleteLimit) || args.deleteLimit < 1)) {
    throw new Error("--delete-limit must be a positive integer");
  }
  if (args.sampleProducts !== null && (!Number.isInteger(args.sampleProducts) || args.sampleProducts < 1 || args.sampleProducts > 250)) {
    throw new Error("--sample-products must be an integer between 1 and 250");
  }

  if (!args.runDir) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    args.runDir = join(process.cwd(), "catalog-runs", stamp);
  }

  return args;
}

function printHelp() {
  console.log(`
Usage:
  node scripts/catalog-cleanup.mjs run [options]

Options:
  --run-dir <path>          Output directory for backups and audit files
  --keep <number>           Number of products to keep active (default: 10000)
  --seed <text>             Deterministic random seed for keep selection
  --skip-export             Reuse existing raw export in --run-dir
  --delete-limit <number>   Cap products deleted in this run; useful for a live test
  --sample-products <n>     Export only the first n products for a fast smoke test
  --confirm-delete <text>   Must equal ${DELETE_CONFIRMATION} to delete
  --poll-seconds <number>   Bulk operation polling interval (default: 20)

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
  if (shop !== REQUIRED_STORE) {
    throw new Error(`Refusing to run against ${shop}; expected ${REQUIRED_STORE}`);
  }
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
  if (!response.ok) {
    throw new Error(`Shopify HTTP ${response.status}: ${JSON.stringify(json)}`);
  }
  if (json?.errors?.length) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json;
}

async function startBulkQuery(config) {
  const query = `
    mutation StartProductExport($query: String!) {
      bulkOperationRunQuery(query: $query, groupObjects: false) {
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
  const json = await shopifyGraphql(config, query, { query: BULK_PRODUCTS_QUERY });
  const payload = json.data.bulkOperationRunQuery;
  if (payload.userErrors.length) {
    throw new Error(`bulkOperationRunQuery failed: ${JSON.stringify(payload.userErrors)}`);
  }
  return payload.bulkOperation;
}

async function exportSampleProducts(config, path, count) {
  const query = `
    query ProductSample($first: Int!) {
      products(first: $first) {
        edges {
          node {
            __typename
            id
            legacyResourceId
            title
            handle
            descriptionHtml
            vendor
            productType
            status
            tags
            createdAt
            updatedAt
            publishedAt
            onlineStoreUrl
            totalInventory
            tracksInventory
            seo {
              title
              description
            }
            options {
              id
              name
              position
              values
            }
            variants(first: 100) {
              edges {
                node {
                  __typename
                  id
                  legacyResourceId
                  title
                  sku
                  barcode
                  price
                  compareAtPrice
                  inventoryPolicy
                  taxable
                  selectedOptions {
                    name
                    value
                  }
                  inventoryItem {
                    id
                    requiresShipping
                    tracked
                    unitCost {
                      amount
                      currencyCode
                    }
                  }
                }
              }
            }
            media(first: 20) {
              edges {
                node {
                  __typename
                  id
                  alt
                  mediaContentType
                  status
                  preview {
                    image {
                      url
                    }
                  }
                  ... on MediaImage {
                    image {
                      url
                      altText
                    }
                  }
                  ... on Video {
                    sources {
                      url
                      mimeType
                    }
                  }
                  ... on ExternalVideo {
                    originUrl
                  }
                  ... on Model3d {
                    sources {
                      url
                      mimeType
                    }
                  }
                }
              }
            }
            metafields(first: 20) {
              edges {
                node {
                  __typename
                  id
                  namespace
                  key
                  value
                  type
                }
              }
            }
          }
        }
      }
    }
  `;

  const json = await shopifyGraphql(config, query, { first: count });
  const stream = createWriteStream(path);
  for (const edge of json.data.products.edges) {
    const product = edge.node;
    const variants = product.variants?.edges?.map((variantEdge) => variantEdge.node) || [];
    const media = product.media?.edges?.map((mediaEdge) => mediaEdge.node) || [];
    const metafields = product.metafields?.edges?.map((metafieldEdge) => metafieldEdge.node) || [];
    delete product.variants;
    delete product.media;
    delete product.metafields;
    stream.write(`${JSON.stringify(product)}\n`);
    for (const variant of variants) stream.write(`${JSON.stringify({ ...variant, __parentId: product.id })}\n`);
    for (const item of media) stream.write(`${JSON.stringify({ ...item, __parentId: product.id })}\n`);
    for (const metafield of metafields) stream.write(`${JSON.stringify({ ...metafield, __parentId: product.id })}\n`);
  }
  await closeStream(stream);
}

async function pollBulkOperation(config, id, pollSeconds) {
  const query = `
    query BulkOperationStatus($id: ID!) {
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

  while (true) {
    const json = await shopifyGraphql(config, query, { id });
    const operation = json.data.node;
    if (!operation) throw new Error(`Bulk operation ${id} was not found`);
    console.log(`[bulk] ${operation.type} ${operation.status} root=${operation.rootObjectCount} objects=${operation.objectCount}`);

    if (operation.status === "COMPLETED") return operation;
    if (["FAILED", "CANCELED", "EXPIRED"].includes(operation.status)) {
      throw new Error(`Bulk operation ${operation.status}: ${JSON.stringify(operation)}`);
    }
    await sleep(pollSeconds * 1000);
  }
}

async function downloadToFile(url, path) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed ${response.status} for ${url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(path));
}

async function gzipFile(inputPath, outputPath) {
  await pipeline(createReadStream(inputPath), createGzip({ level: 9 }), createWriteStream(outputPath));
}

async function parseBulkProducts(rawPath) {
  const products = new Map();
  const variantsByProduct = new Map();
  const mediaByProduct = new Map();
  const metafieldsByProduct = new Map();

  const rl = createInterface({
    input: createReadStream(rawPath),
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    const item = JSON.parse(line);
    const parentId = item.__parentId;
    delete item.__parentId;

    if (item.__typename === "Product") {
      products.set(item.id, { ...item, variants: [], media: [], metafields: [] });
    } else if (item.__typename === "ProductVariant") {
      pushMapArray(variantsByProduct, parentId, item);
    } else if (item.__typename === "Metafield") {
      pushMapArray(metafieldsByProduct, parentId, item);
    } else if (item.__typename) {
      pushMapArray(mediaByProduct, parentId, item);
    }
  }

  for (const [id, product] of products) {
    product.variants = variantsByProduct.get(id) || [];
    product.media = mediaByProduct.get(id) || [];
    product.metafields = metafieldsByProduct.get(id) || [];
  }

  return [...products.values()];
}

function pushMapArray(map, key, value) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

async function writeStructuredBackup(products, path) {
  const stream = createWriteStream(path);
  for (const product of products) {
    stream.write(`${JSON.stringify(product)}\n`);
  }
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

function csvCell(value) {
  const text = Array.isArray(value) ? value.join(", ") : String(value ?? "");
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function shopifyRows(products) {
  const rows = [];
  for (const product of products) {
    const variants = product.variants.length ? product.variants : [null];
    const images = product.media.map(mediaUrl).filter(Boolean);

    variants.forEach((variant, index) => {
      const selected = selectedOptions(variant, product);
      rows.push({
        "Handle": product.handle,
        "Title": index === 0 ? product.title : "",
        "Body (HTML)": index === 0 ? product.descriptionHtml || "" : "",
        "Vendor": index === 0 ? product.vendor || "" : "",
        "Product Category": "",
        "Type": index === 0 ? product.productType || "" : "",
        "Tags": index === 0 ? (product.tags || []).join(", ") : "",
        "Published": product.status === "ACTIVE" ? "TRUE" : "FALSE",
        "Option1 Name": selected[0]?.name || "Title",
        "Option1 Value": selected[0]?.value || "Default Title",
        "Option2 Name": selected[1]?.name || "",
        "Option2 Value": selected[1]?.value || "",
        "Option3 Name": selected[2]?.name || "",
        "Option3 Value": selected[2]?.value || "",
        "Variant SKU": variant?.sku || "",
        "Variant Grams": "",
        "Variant Inventory Tracker": variant?.inventoryItem?.tracked ? "shopify" : "",
        "Variant Inventory Qty": "",
        "Variant Inventory Policy": variant?.inventoryPolicy || "",
        "Variant Fulfillment Service": "manual",
        "Variant Price": variant?.price || "",
        "Variant Compare At Price": variant?.compareAtPrice || "",
        "Variant Requires Shipping": variant?.inventoryItem?.requiresShipping === false ? "FALSE" : "TRUE",
        "Variant Taxable": variant?.taxable === false ? "FALSE" : "TRUE",
        "Variant Barcode": variant?.barcode || "",
        "Image Src": index === 0 ? images[0] || "" : "",
        "Image Position": index === 0 && images[0] ? "1" : "",
        "Image Alt Text": index === 0 ? product.media[0]?.alt || product.media[0]?.image?.altText || "" : "",
        "Gift Card": "FALSE",
        "SEO Title": index === 0 ? product.seo?.title || "" : "",
        "SEO Description": index === 0 ? product.seo?.description || "" : "",
        "Status": product.status?.toLowerCase() || ""
      });
    });
  }
  return rows;
}

function deletedSkuRows(products, deletedAt) {
  const rows = [];
  for (const product of products) {
    const images = product.media.map(mediaUrl).filter(Boolean).join(" | ");
    const variants = product.variants.length ? product.variants : [null];
    for (const variant of variants) {
      rows.push({
        "product_id": product.id,
        "product_handle": product.handle,
        "product_title": product.title,
        "variant_id": variant?.id || "",
        "variant_title": variant?.title || "",
        "sku": variant?.sku || "",
        "barcode": variant?.barcode || "",
        "vendor": product.vendor || "",
        "product_type": product.productType || "",
        "status_before_delete": product.status || "",
        "price": variant?.price || "",
        "compare_at_price": variant?.compareAtPrice || "",
        "inventory_item_id": variant?.inventoryItem?.id || "",
        "image_urls": images,
        "deleted_at": deletedAt
      });
    }
  }
  return rows;
}

function deletedProductRows(products) {
  return products.map((product) => ({
    product_id: product.id,
    product_handle: product.handle,
    product_title: product.title,
    status_before_delete: product.status || "",
    variant_count: product.variants.length,
    sku_count: product.variants.filter((variant) => variant.sku).length
  }));
}

function keptProductRows(products) {
  const rows = [];
  for (const product of products) {
    const variants = product.variants.length ? product.variants : [null];
    for (const variant of variants) {
      rows.push({
        product_id: product.id,
        product_handle: product.handle,
        product_title: product.title,
        variant_id: variant?.id || "",
        sku: variant?.sku || "",
        status: product.status || ""
      });
    }
  }
  return rows;
}

function selectedOptions(variant, product) {
  if (variant?.selectedOptions?.length) return variant.selectedOptions;
  return (product.options || []).slice(0, 3).map((option) => ({
    name: option.name,
    value: option.values?.[0] || "Default Title"
  }));
}

function mediaUrl(media) {
  return media?.image?.url || media?.preview?.image?.url || media?.originUrl || media?.sources?.[0]?.url || "";
}

async function writeDeleteInput(path, products) {
  const stream = createWriteStream(path);
  for (const product of products) {
    stream.write(`${JSON.stringify({ input: { id: product.id } })}\n`);
  }
  await closeStream(stream);
}

async function stagedUpload(config, jsonlPath) {
  const filename = basename(jsonlPath);
  const query = `
    mutation CreateBulkMutationStagedUpload($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
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
  const variables = {
    input: [{
      resource: "BULK_MUTATION_VARIABLES",
      filename,
      mimeType: "text/jsonl",
      httpMethod: "POST"
    }]
  };
  const json = await shopifyGraphql(config, query, variables);
  const payload = json.data.stagedUploadsCreate;
  if (payload.userErrors.length) {
    throw new Error(`stagedUploadsCreate failed: ${JSON.stringify(payload.userErrors)}`);
  }

  const target = payload.stagedTargets[0];
  const form = new FormData();
  for (const param of target.parameters) {
    form.append(param.name, param.value);
  }
  const buffer = await readFile(jsonlPath);
  form.append("file", new Blob([buffer], { type: "text/jsonl" }), filename);

  const upload = await fetch(target.url, { method: "POST", body: form });
  if (!upload.ok) {
    throw new Error(`Staged upload failed: HTTP ${upload.status} ${await upload.text()}`);
  }

  const key = target.parameters.find((param) => param.name === "key")?.value;
  if (!key) throw new Error("Staged upload response did not include a key parameter");
  return key;
}

async function startBulkDelete(config, stagedUploadPath) {
  const query = `
    mutation StartBulkDelete($mutation: String!, $stagedUploadPath: String!) {
      bulkOperationRunMutation(
        mutation: $mutation,
        stagedUploadPath: $stagedUploadPath,
        groupObjects: false,
        clientIdentifier: "exclusive-motors-au-hard-delete"
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
  const json = await shopifyGraphql(config, query, {
    mutation: PRODUCT_DELETE_MUTATION,
    stagedUploadPath
  });
  const payload = json.data.bulkOperationRunMutation;
  if (payload.userErrors.length) {
    throw new Error(`bulkOperationRunMutation failed: ${JSON.stringify(payload.userErrors)}`);
  }
  return payload.bulkOperation;
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

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function fileInfo(path) {
  const info = await stat(path);
  return {
    bytes: info.size,
    sha256: await hashFile(path)
  };
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
  await mkdir(args.runDir, { recursive: true });

  const paths = {
    rawJsonl: join(args.runDir, "bulk-query-raw.jsonl"),
    rawJsonlGz: join(args.runDir, "bulk-query-raw.jsonl.gz"),
    fullJsonl: join(args.runDir, "all-products-full.jsonl"),
    fullJsonlGz: join(args.runDir, "all-products-full.jsonl.gz"),
    shopifyCsv: join(args.runDir, "all-products-shopify-import.csv"),
    deletedSkusCsv: join(args.runDir, "deleted-skus.csv"),
    deletedProductsCsv: join(args.runDir, "deleted-products.csv"),
    keptProductsCsv: join(args.runDir, "kept-products.csv"),
    deleteInput: join(args.runDir, "delete-input.jsonl"),
    deleteResults: join(args.runDir, "delete-results.jsonl")
  };

  const manifest = {
    started_at: new Date().toISOString(),
    shop: config.shop,
    api_version: config.apiVersion,
    keep_requested: args.keep,
    delete_limit: args.deleteLimit,
    sample_products: args.sampleProducts,
    seed: args.seed,
    run_dir: args.runDir,
    destructive_confirmed: args.confirmDelete === DELETE_CONFIRMATION,
    files: {},
    counts: {},
    operations: {}
  };

  const before = await getShopSnapshot(config);
  manifest.shop_snapshot_before = before;
  console.log(`[shop] ${before.shop.name} ${before.shop.myshopifyDomain} products=${before.productsCount.count}`);

  if (!args.skipExport) {
    if (args.sampleProducts) {
      console.log(`[export] writing direct sample export for ${args.sampleProducts} products`);
      manifest.operations.export = { type: "SAMPLE", requested_products: args.sampleProducts };
      await exportSampleProducts(config, paths.rawJsonl, args.sampleProducts);
    } else {
      console.log("[export] starting product bulk query");
      const exportOperation = await startBulkQuery(config);
      manifest.operations.export = exportOperation;
      await writeManifest(args.runDir, manifest);

      const completedExport = await pollBulkOperation(config, exportOperation.id, args.pollSeconds);
      manifest.operations.export = completedExport;
      if (!completedExport.url) throw new Error("Completed export did not include a download URL");
      console.log("[export] downloading raw JSONL");
      await downloadToFile(completedExport.url, paths.rawJsonl);
    }
    await gzipFile(paths.rawJsonl, paths.rawJsonlGz);
  } else {
    console.log("[export] skipping bulk export; reusing existing raw JSONL");
  }

  console.log("[backup] parsing products and writing backup files");
  const products = await parseBulkProducts(paths.rawJsonl);
  const keepIds = chooseKeepProductIds(products, args.keep, args.seed);
  const { keptProducts, deletedProducts } = partitionProductsForDeletion(products, keepIds, args.deleteLimit);
  const deletedAt = new Date().toISOString();

  await writeStructuredBackup(products, paths.fullJsonl);
  await gzipFile(paths.fullJsonl, paths.fullJsonlGz);
  await writeCsv(paths.shopifyCsv, SHOPIFY_CSV_HEADERS, shopifyRows(products));
  await writeCsv(paths.deletedSkusCsv, DELETED_SKU_HEADERS, deletedSkuRows(deletedProducts, deletedAt));
  await writeCsv(paths.deletedProductsCsv, ["product_id", "product_handle", "product_title", "status_before_delete", "variant_count", "sku_count"], deletedProductRows(deletedProducts));
  await writeCsv(paths.keptProductsCsv, ["product_id", "product_handle", "product_title", "variant_id", "sku", "status"], keptProductRows(keptProducts));
  await writeDeleteInput(paths.deleteInput, deletedProducts);

  manifest.counts = {
    products_exported: products.length,
    products_kept: keptProducts.length,
    products_to_delete: deletedProducts.length,
    variants_exported: products.reduce((sum, product) => sum + product.variants.length, 0),
    deleted_sku_rows: deletedProducts.reduce((sum, product) => sum + Math.max(product.variants.length, 1), 0)
  };

  for (const [key, path] of Object.entries(paths)) {
    if (key === "deleteResults") continue;
    manifest.files[basename(path)] = await fileInfo(path);
  }
  manifest.pre_delete_validated_at = new Date().toISOString();
  await writeManifest(args.runDir, manifest);

  console.log(`[backup] products=${manifest.counts.products_exported} kept=${manifest.counts.products_kept} delete=${manifest.counts.products_to_delete}`);
  console.log(`[backup] manifest written to ${join(args.runDir, "manifest.json")}`);

  if (args.confirmDelete !== DELETE_CONFIRMATION) {
    console.log(`[stop] deletion not run. Pass --confirm-delete ${DELETE_CONFIRMATION} after reviewing backups.`);
    return;
  }

  if (deletedProducts.length === 0) {
    console.log("[delete] nothing to delete");
    return;
  }

  console.log("[delete] uploading delete input JSONL");
  const stagedUploadPath = await stagedUpload(config, paths.deleteInput);
  manifest.operations.delete_staged_upload_path = stagedUploadPath;
  await writeManifest(args.runDir, manifest);

  console.log("[delete] starting Shopify bulk productDelete mutation");
  const deleteOperation = await startBulkDelete(config, stagedUploadPath);
  manifest.operations.delete = deleteOperation;
  await writeManifest(args.runDir, manifest);

  const completedDelete = await pollBulkOperation(config, deleteOperation.id, args.pollSeconds);
  manifest.operations.delete = completedDelete;
  if (completedDelete.url) {
    await downloadToFile(completedDelete.url, paths.deleteResults);
    manifest.files[basename(paths.deleteResults)] = await fileInfo(paths.deleteResults);
  }

  const after = await getShopSnapshot(config);
  manifest.shop_snapshot_after = after;
  manifest.completed_at = new Date().toISOString();
  await writeManifest(args.runDir, manifest);
  console.log(`[done] Shopify now reports products=${after.productsCount.count}`);
}

main().catch((error) => {
  console.error(`[error] ${error.message}`);
  process.exitCode = 1;
});
