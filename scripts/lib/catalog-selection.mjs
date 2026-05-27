import { createHash } from "node:crypto";

export function chooseKeepProductIds(products, keepCount, seed) {
  return new Set(
    products
      .map((product) => ({
        id: product.id,
        hash: createHash("sha256").update(`${seed}\0${product.id}`).digest("hex")
      }))
      .sort((a, b) => a.hash.localeCompare(b.hash))
      .slice(0, Math.min(keepCount, products.length))
      .map((item) => item.id)
  );
}

export function partitionProductsForDeletion(products, keepIds, deleteLimit = null) {
  const keptProducts = products.filter((product) => keepIds.has(product.id));
  const deletedProducts = products.filter((product) => !keepIds.has(product.id));

  if (deleteLimit === null || deleteLimit === undefined) {
    return { keptProducts, deletedProducts };
  }

  const limitedDeletedProducts = deletedProducts.slice(0, deleteLimit);
  const limitedDeletedIds = new Set(limitedDeletedProducts.map((product) => product.id));

  return {
    keptProducts: products.filter((product) => !limitedDeletedIds.has(product.id)),
    deletedProducts: limitedDeletedProducts
  };
}
