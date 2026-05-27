import assert from "node:assert/strict";
import test from "node:test";

import {
  chooseKeepProductIds,
  partitionProductsForDeletion
} from "../scripts/lib/catalog-selection.mjs";

const products = Array.from({ length: 8 }, (_, index) => ({
  id: `gid://shopify/Product/${index + 1}`,
  handle: `product-${index + 1}`
}));

test("chooseKeepProductIds is deterministic for the same seed", () => {
  const first = [...chooseKeepProductIds(products, 3, "seed-a")];
  const second = [...chooseKeepProductIds(products, 3, "seed-a")];

  assert.deepEqual(first, second);
  assert.equal(first.length, 3);
});

test("partitionProductsForDeletion caps destructive work with deleteLimit", () => {
  const keepIds = new Set(products.slice(0, 2).map((product) => product.id));
  const { keptProducts, deletedProducts } = partitionProductsForDeletion(products, keepIds, 3);

  assert.equal(deletedProducts.length, 3);
  assert.equal(keptProducts.length, 5);
  assert(deletedProducts.every((product) => !keepIds.has(product.id)));
  assert.equal(new Set([...keptProducts, ...deletedProducts].map((product) => product.id)).size, products.length);
});

test("partitionProductsForDeletion leaves full delete set when no deleteLimit is set", () => {
  const keepIds = new Set(products.slice(0, 2).map((product) => product.id));
  const { keptProducts, deletedProducts } = partitionProductsForDeletion(products, keepIds);

  assert.equal(keptProducts.length, 2);
  assert.equal(deletedProducts.length, 6);
});
