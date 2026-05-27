import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCatalogTitle } from "../scripts/lib/title-normalization.mjs";

test("removes separated scraped punctuation prefixes", () => {
  assert.deepEqual(normalizeCatalogTitle("/ Fuel Filter"), {
    changed: true,
    title: "Fuel Filter"
  });
  assert.equal(normalizeCatalogTitle("' Fuel Filter").title, "Fuel Filter");
  assert.equal(normalizeCatalogTitle("//   Fuel Filter").title, "Fuel Filter");
  assert.equal(normalizeCatalogTitle('| " Brake Pad').title, "Brake Pad");
  assert.equal(normalizeCatalogTitle("\u2018 Fuel Filter").title, "Fuel Filter");
});

test("preserves attached technical or dimensional prefixes", () => {
  for (const title of ['.874" Retrofit Kit', "-3 AN Hose", "/AN Fitting", "+12V Relay"]) {
    assert.deepEqual(normalizeCatalogTitle(title), { changed: false, title });
  }
});

test("leaves ordinary titles unchanged", () => {
  assert.deepEqual(normalizeCatalogTitle("Fuel Filter"), {
    changed: false,
    title: "Fuel Filter"
  });
});
