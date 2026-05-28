import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("bulk product query avoids fields missing from ProductVariant in 2026-01", async () => {
  const source = await readFile(new URL("../scripts/catalog-cleanup.mjs", import.meta.url), "utf8");

  assert.doesNotMatch(source, /\n {14}requiresShipping\n/);
  assert.doesNotMatch(source, /\n {14}image \{/);
});

test("remediation runner locks the store and uses guarded title and inventory mutations", async () => {
  const source = await readFile(new URL("../scripts/catalog-remediation.mjs", import.meta.url), "utf8");
  const planSource = await readFile(new URL("../scripts/lib/remediation-plan.mjs", import.meta.url), "utf8");

  assert.match(source, /hpas5s-eu\.myshopify\.com/);
  assert.match(source, /2026-01/);
  assert.match(source, /productUpdate/);
  assert.match(source, /inventorySetQuantities/);
  assert.match(planSource, /changeFromQuantity/);
  assert.match(source, /@idempotent/);
  assert.match(source, /bulkOperationRunMutation/);
  assert.match(source, /Promise\.all/);
});

test("catalog wrapper exposes plan, 40-product test, and full remediation commands", async () => {
  const source = await readFile(new URL("../bin/catalog", import.meta.url), "utf8");

  assert.match(source, /fix-plan/);
  assert.match(source, /fix-test/);
  assert.match(source, /fix-all/);
  assert.match(source, /--apply-limit 40/);
  assert.match(source, /FIX_EXCLUSIVE_MOTORS_AU_CATALOG/);
});
