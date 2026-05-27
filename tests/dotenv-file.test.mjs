import assert from "node:assert/strict";
import test from "node:test";

import { parseEnvContent, upsertEnvBlock } from "../scripts/lib/dotenv-file.mjs";

test("parseEnvContent ignores pasted shell snippets and keeps valid keys", () => {
  const parsed = parseEnvContent(`
SHOPIFY_ADMIN_API_DOMAIN=hpas5s-eu.myshopify.com
curl -X POST "https://example.myshopify.com/admin/oauth/access_token" \\
"client_secret": "do-not-parse"
SHOPIFY_ADMIN_API_VERSION=2026-01
`);

  assert.deepEqual(parsed, {
    SHOPIFY_ADMIN_API_DOMAIN: "hpas5s-eu.myshopify.com",
    SHOPIFY_ADMIN_API_VERSION: "2026-01"
  });
});

test("upsertEnvBlock replaces managed keys without touching unrelated keys", () => {
  const content = upsertEnvBlock("OPENAI_API_KEY=kept\nSHOPIFY_ADMIN_API_DOMAIN=old\n", {
    SHOPIFY_ADMIN_API_DOMAIN: "hpas5s-eu.myshopify.com",
    SHOPIFY_ADMIN_API_VERSION: "2026-01"
  });

  assert.match(content, /OPENAI_API_KEY=kept/);
  assert.doesNotMatch(content, /SHOPIFY_ADMIN_API_DOMAIN=old/);
  assert.match(content, /SHOPIFY_ADMIN_API_DOMAIN=hpas5s-eu\.myshopify\.com/);
  assert.match(content, /# Exclusive Motors AU catalog cleanup/);
});
