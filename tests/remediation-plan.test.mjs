import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_BULK_INPUT_BYTES,
  assertBulkInputSize,
  buildInventoryPlan,
  buildTitleChanges,
  selectRemediationProducts
} from "../scripts/lib/remediation-plan.mjs";

const locationId = "gid://shopify/Location/90543390932";
const products = [
  {
    id: "gid://shopify/Product/1",
    handle: "fuel-filter",
    title: "/ Fuel Filter",
    variants: [{
      id: "gid://shopify/ProductVariant/1",
      sku: "SKU-1",
      inventoryItem: {
        id: "gid://shopify/InventoryItem/1",
        tracked: true,
        inventoryLevels: {
          nodes: [{
            location: { id: locationId },
            quantities: [{ name: "available", quantity: 0 }]
          }]
        }
      }
    }]
  },
  {
    id: "gid://shopify/Product/2",
    handle: "retrofit-kit",
    title: '.874" Retrofit Kit',
    variants: [{
      id: "gid://shopify/ProductVariant/2",
      sku: "SKU-2",
      inventoryItem: {
        id: "gid://shopify/InventoryItem/2",
        tracked: true,
        inventoryLevels: {
          nodes: [{
            location: { id: locationId },
            quantities: [{ name: "available", quantity: 3 }]
          }]
        }
      }
    }]
  }
];

test("buildTitleChanges emits mutation data only for changed titles", () => {
  const rows = buildTitleChanges(products);

  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    productId: "gid://shopify/Product/1",
    handle: "fuel-filter",
    beforeTitle: "/ Fuel Filter",
    afterTitle: "Fuel Filter",
    variables: {
      product: {
        id: "gid://shopify/Product/1",
        title: "Fuel Filter"
      }
    }
  });
});

test("selectRemediationProducts prioritizes titles that exercise cleanup", () => {
  const candidates = [
    products[1],
    products[0],
    { ...products[0], id: "gid://shopify/Product/3", title: "' Air Filter" }
  ];

  const selected = selectRemediationProducts(candidates, 2);

  assert.deepEqual(selected.map((product) => product.id), [
    "gid://shopify/Product/1",
    "gid://shopify/Product/3"
  ]);
});

test("buildInventoryPlan isolates each compare-and-set inventory mutation row", () => {
  const manyProducts = Array.from({ length: 251 }, (_, index) => {
    const source = products[index % products.length];
    const variant = source.variants[0];
    return {
      ...source,
      id: `gid://shopify/Product/${index + 1}`,
      variants: [{
        ...variant,
        id: `gid://shopify/ProductVariant/${index + 1}`,
        inventoryItem: {
          ...variant.inventoryItem,
          id: `gid://shopify/InventoryItem/${index + 1}`
        }
      }]
    };
  });

  const plan = buildInventoryPlan(manyProducts, {
    locationId,
    targetQuantity: 10,
    runId: "test-run"
  });

  assert.equal(plan.changes.length, 251);
  assert.equal(plan.batches.length, 251);
  assert.equal(plan.batches[0].variables.input.quantities.length, 1);
  assert.equal(plan.batches[250].variables.input.quantities.length, 1);
  assert.deepEqual(plan.batches[0].variables.input.quantities[0], {
    inventoryItemId: "gid://shopify/InventoryItem/1",
    locationId,
    quantity: 10,
    changeFromQuantity: 0
  });
  assert.match(plan.batches[0].variables.idempotencyKey, /^test-run-inventory-1-/);
});

test("buildInventoryPlan records untracked or unstocked variants without mutating them", () => {
  const noInventory = [{
    ...products[0],
    variants: [{
      ...products[0].variants[0],
      inventoryItem: {
        id: "gid://shopify/InventoryItem/3",
        tracked: false,
        inventoryLevels: { nodes: [] }
      }
    }]
  }];

  const plan = buildInventoryPlan(noInventory, { locationId, targetQuantity: 10, runId: "test-run" });

  assert.equal(plan.changes.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].reason, "inventory_not_tracked");
});

test("buildInventoryPlan accepts Shopify's singular inventoryLevel query shape", () => {
  const singularShapeProduct = {
    ...products[0],
    variants: [{
      ...products[0].variants[0],
      inventoryItem: {
        id: "gid://shopify/InventoryItem/99",
        tracked: true,
        inventoryLevel: {
          location: { id: locationId },
          quantities: [{ name: "available", quantity: 0 }]
        }
      }
    }]
  };

  const plan = buildInventoryPlan([singularShapeProduct], { locationId, targetQuantity: 10, runId: "test-run" });

  assert.equal(plan.changes.length, 1);
  assert.equal(plan.skipped.length, 0);
});

test("assertBulkInputSize rejects inputs beyond Shopify's 100 MB limit", () => {
  assert.doesNotThrow(() => assertBulkInputSize(MAX_BULK_INPUT_BYTES));
  assert.throws(() => assertBulkInputSize(MAX_BULK_INPUT_BYTES + 1), /100 MB/);
});
