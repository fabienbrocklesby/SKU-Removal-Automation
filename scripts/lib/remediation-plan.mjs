import { createHash } from "node:crypto";

import { normalizeCatalogTitle } from "./title-normalization.mjs";

export const MAX_BULK_INPUT_BYTES = 100 * 1024 * 1024;

export function buildTitleChanges(products) {
  const changes = [];
  for (const product of products) {
    const result = normalizeCatalogTitle(product.title);
    if (!result.changed) continue;
    changes.push({
      productId: product.id,
      handle: product.handle,
      beforeTitle: product.title,
      afterTitle: result.title,
      variables: {
        product: {
          id: product.id,
          title: result.title
        }
      }
    });
  }
  return changes;
}

export function selectRemediationProducts(products, limit = null) {
  if (limit === null || limit === undefined) return products;
  const changed = [];
  const unchanged = [];
  for (const product of products) {
    if (normalizeCatalogTitle(product.title).changed) changed.push(product);
    else unchanged.push(product);
  }
  return [...changed, ...unchanged].slice(0, limit);
}

export function buildInventoryPlan(products, { locationId, targetQuantity, runId }) {
  const changes = [];
  const skipped = [];

  for (const product of products) {
    for (const variant of product.variants || []) {
      const inventoryItem = variant.inventoryItem;
      if (!inventoryItem?.tracked) {
        skipped.push(inventorySkip(product, variant, inventoryItem, "inventory_not_tracked"));
        continue;
      }
      const level = inventoryLevelForLocation(inventoryItem, locationId);
      if (!level) {
        skipped.push(inventorySkip(product, variant, inventoryItem, "not_stocked_at_location"));
        continue;
      }
      const beforeQuantity = level.quantities?.find((quantity) => quantity.name === "available")?.quantity;
      if (!Number.isInteger(beforeQuantity)) {
        skipped.push(inventorySkip(product, variant, inventoryItem, "available_quantity_missing"));
        continue;
      }
      changes.push({
        productId: product.id,
        productTitle: product.title,
        variantId: variant.id,
        sku: variant.sku || "",
        inventoryItemId: inventoryItem.id,
        locationId,
        beforeQuantity,
        targetQuantity
      });
    }
  }

  const batches = [];
  for (let index = 0; index < changes.length; index += 1) {
    const quantities = [changes[index]].map((change) => ({
      inventoryItemId: change.inventoryItemId,
      locationId: change.locationId,
      quantity: change.targetQuantity,
      changeFromQuantity: change.beforeQuantity
    }));
    const digest = createHash("sha256").update(JSON.stringify(quantities)).digest("hex").slice(0, 16);
    batches.push({
      changes: [changes[index]],
      variables: {
        input: {
          name: "available",
          reason: "correction",
          referenceDocumentUri: `catalog-remediation://${runId}/inventory`,
          quantities
        },
        idempotencyKey: `${runId}-inventory-${batches.length + 1}-${digest}`
      }
    });
  }

  return { changes, skipped, batches };
}

export function assertBulkInputSize(bytes) {
  if (bytes > MAX_BULK_INPUT_BYTES) {
    throw new Error("Bulk mutation input exceeds Shopify's 100 MB JSONL limit");
  }
}

function inventorySkip(product, variant, inventoryItem, reason) {
  return {
    productId: product.id,
    productTitle: product.title,
    variantId: variant.id,
    sku: variant.sku || "",
    inventoryItemId: inventoryItem?.id || "",
    reason
  };
}

function inventoryLevelForLocation(inventoryItem, locationId) {
  if (inventoryItem.inventoryLevel?.location?.id === locationId) return inventoryItem.inventoryLevel;
  return inventoryItem.inventoryLevels?.nodes?.find((entry) => entry.location?.id === locationId) || null;
}
