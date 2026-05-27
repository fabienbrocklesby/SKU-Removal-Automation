import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("bulk product query avoids fields missing from ProductVariant in 2026-01", async () => {
  const source = await readFile(new URL("../scripts/catalog-cleanup.mjs", import.meta.url), "utf8");

  assert.doesNotMatch(source, /\n {14}requiresShipping\n/);
  assert.doesNotMatch(source, /\n {14}image \{/);
});
