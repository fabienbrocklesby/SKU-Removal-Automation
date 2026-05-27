# Exclusive Motors AU Catalog Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add guarded server-run workflows that automatically clean clearly malformed retained-product titles and set available inventory to 10, validate them on 40 products, then safely apply them to the full remaining catalog.

**Architecture:** Extend the existing Node/Docker CLI with a separate remediation runner. A single pre-change export produces auditable title and inventory plans, then title `productUpdate` and inventory `inventorySetQuantities` bulk mutation jobs run concurrently using Shopify Admin API `2026-01`. Pure title and mutation-plan logic lives in tested library modules; live operation orchestration follows the existing staged-upload, polling, hashing, and manifest pattern.

**Tech Stack:** Node.js ES modules, built-in `node:test`, Shopify Admin GraphQL API `2026-01`, Docker Compose, shell wrapper, SSH/rsync deployment and artifact retrieval.

---

## File Map

- Modify: `README.md` - operator commands, artifacts, test/full remediation runbook.
- Modify: `bin/catalog` - expose `fix-plan`, `fix-test`, and `fix-all` Docker commands with fixed store/action confirmation.
- Preserve and commit: `scripts/catalog-cleanup.mjs` - existing low-memory deletion-run resume work already present locally and on the VPS.
- Create: `scripts/lib/title-normalization.mjs` - deterministic title cleanup rule only.
- Create: `scripts/lib/remediation-plan.mjs` - title changes, inventory batches, CSV/JSONL record shaping, input-size checks.
- Create: `scripts/catalog-remediation.mjs` - live export, artifact hashing, Shopify bulk mutations, result retrieval, and verification.
- Create: `tests/title-normalization.test.mjs` - prefix behavior regression tests.
- Create: `tests/remediation-plan.test.mjs` - mutation-plan, batching, and guard tests.
- Create or modify as needed: `tests/shopify-query.test.mjs` - static GraphQL safety assertions for the remediation query/mutations.

### Task 1: Preserve Existing Deletion Resume Work

**Files:**
- Modify: `README.md`
- Modify: `bin/catalog`
- Modify: `scripts/catalog-cleanup.mjs`

- [ ] **Step 1: Inspect the local and VPS diffs before staging**

Run:

```bash
git diff -- README.md bin/catalog scripts/catalog-cleanup.mjs
ssh automation-management 'cd /opt/exclusive-motors-au-sku-manage && git diff -- README.md bin/catalog scripts/catalog-cleanup.mjs'
```

Expected: both contain the low-memory streaming/resume functionality used for
the completed full deletion run; neither contains secrets.

- [ ] **Step 2: Run existing automated tests against the current working tree**

Run: `npm test`

Expected: all current tests pass before remediation edits.

- [ ] **Step 3: Commit the already-present resume work separately**

```bash
git add README.md bin/catalog scripts/catalog-cleanup.mjs
git commit -m "fix: preserve low-memory catalog deletion resume workflow"
```

Expected: remediation implementation starts from a committed representation of
the code already used on the VPS.

### Task 2: Title Normalization Rule

**Files:**
- Create: `tests/title-normalization.test.mjs`
- Create: `scripts/lib/title-normalization.mjs`

- [ ] **Step 1: Write failing tests for removable and protected prefixes**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCatalogTitle } from "../scripts/lib/title-normalization.mjs";

test("removes separated scraped punctuation prefixes", () => {
  assert.deepEqual(normalizeCatalogTitle("/ Fuel Filter"), {
    changed: true,
    title: "Fuel Filter"
  });
  assert.equal(normalizeCatalogTitle("' Fuel Filter").title, "Fuel Filter");
  assert.equal(normalizeCatalogTitle('| " Brake Pad').title, "Brake Pad");
});

test("preserves attached technical or dimensional prefixes", () => {
  for (const title of ['.874" Retrofit Kit', "-3 AN Hose", "/AN Fitting", "+12V Relay"]) {
    assert.deepEqual(normalizeCatalogTitle(title), { changed: false, title });
  }
});
```

- [ ] **Step 2: Run the test to confirm RED**

Run: `node --test tests/title-normalization.test.mjs`

Expected: FAIL because `scripts/lib/title-normalization.mjs` does not exist.

- [ ] **Step 3: Implement the minimal pure normalizer**

Implement `normalizeCatalogTitle(title)` using a beginning-only expression for
one or more of `/`, `\`, `'`, `"`, and `|` when followed by whitespace, then
collapse the removed separator and return `{ changed, title }`.

- [ ] **Step 4: Run the focused test to confirm GREEN**

Run: `node --test tests/title-normalization.test.mjs`

Expected: PASS.

### Task 3: Remediation Plan Generation

**Files:**
- Create: `tests/remediation-plan.test.mjs`
- Create: `scripts/lib/remediation-plan.mjs`

- [ ] **Step 1: Write failing tests for title rows and inventory batches**

Tests must assert:

- products with unchanged titles create no title mutation row;
- changed titles create `{ input: { id, title } }` JSONL values and an audit
  record containing before/after titles;
- variants produce isolated inventory set records at
  `gid://shopify/Location/90543390932` with `quantity: 10` and the exported
  current value as `changeFromQuantity`;
- each inventory JSONL row changes one item so a compare conflict cannot fail
  unrelated variants;
- mutation JSONL larger than `100 * 1024 * 1024` bytes is rejected.

- [ ] **Step 2: Run the tests to confirm RED**

Run: `node --test tests/remediation-plan.test.mjs`

Expected: FAIL because plan functions do not exist.

- [ ] **Step 3: Implement minimal plan helpers**

Export focused functions such as:

```js
export function buildTitleChanges(products) {}
export function buildInventoryBatches(products, { locationId, targetQuantity, batchSize = 250 }) {}
export function assertBulkInputSize(bytes) {}
```

Each inventory JSONL row must include an idempotency key variable and an
`input.quantities` array containing one record with `inventoryItemId`,
`locationId`, `quantity: 10`, and `changeFromQuantity`.

- [ ] **Step 4: Run focused and full tests**

Run:

```bash
node --test tests/remediation-plan.test.mjs
npm test
```

Expected: PASS.

### Task 4: Live Remediation Runner And Dry Plan

**Files:**
- Create: `scripts/catalog-remediation.mjs`
- Modify: `tests/shopify-query.test.mjs`

- [ ] **Step 1: Write failing static/query safety tests**

Assert the new runner contains:

- store lock `hpas5s-eu.myshopify.com`;
- API version fallback `2026-01`;
- product export fields needed for IDs, titles, variants, inventory items, and
  available quantity at the active location;
- `productUpdate` title mutation;
- `inventorySetQuantities` mutation using `@idempotent` and
  `changeFromQuantity`.

- [ ] **Step 2: Run the safety test to confirm RED**

Run: `node --test tests/shopify-query.test.mjs`

Expected: FAIL because the remediation runner is absent.

- [ ] **Step 3: Implement export and plan-only operation**

Implement a runner with options:

```text
--run-dir <path>
--sample-products <n>
--target-quantity <n>
--location-id <gid>
--confirm-fix <text>
--poll-seconds <n>
```

It must load `.env`, refuse any other store, query/export selected products,
write compressed pre-change snapshot plus title/inventory CSV and mutation
JSONL inputs, hash files into `manifest.json`, and stop without mutation when
confirmation is absent.

- [ ] **Step 4: Run tests and a server dry plan**

Run locally: `npm test`

After deployment later, run:

```bash
RUN_DIR=catalog-runs/fix-plan-smoke bin/catalog fix-plan
```

Expected: artifacts are created and the manifest records zero apply operations.

### Task 5: Concurrent Apply And Verification Commands

**Files:**
- Modify: `scripts/catalog-remediation.mjs`
- Modify: `bin/catalog`
- Modify: `README.md`

- [ ] **Step 1: Add failing assertions for wrapper commands and confirmation**

Add tests or static assertions that `bin/catalog` exposes `fix-plan`,
`fix-test`, and `fix-all`, with `fix-test` fixed at `40` products and mutating
commands passing the remediation confirmation token.

- [ ] **Step 2: Run tests to confirm RED**

Run: `npm test`

Expected: FAIL until commands are implemented.

- [ ] **Step 3: Implement concurrent mutation execution**

Add staged upload and `bulkOperationRunMutation` handling patterned after
`catalog-cleanup.mjs`. Start the title bulk mutation only when title input has
rows. Start inventory bulk mutation independently; when both have rows, start
both before polling so Shopify can run them concurrently. Download result
JSONL files, identify line/user errors, and update the manifest.

- [ ] **Step 4: Implement post-apply verification**

Refetch the selected products after each apply and record:

- title changes applied versus mismatched/failed;
- variant inventory values that are not `10`;
- compare-and-set conflicts and other Shopify user errors.

The command exits nonzero when a requested mutation fails verification.

- [ ] **Step 5: Document operator flow and run all tests**

Document `fix-plan`, `fix-test`, `fix-all`, artifact names, and server sequence
in `README.md`.

Run: `npm test`

Expected: PASS.

### Task 6: Deploy And Execute On The VPS

**Files:**
- Server working copy: `/opt/exclusive-motors-au-sku-manage`
- Local artifacts: `catalog-runs/server-final-10000-20260527-075502/`

- [ ] **Step 1: Verify downloaded deletion artifacts locally**

Compare local `sha256` and byte sizes for the copied restore/audit artifacts
against the server files and the server manifest.

- [ ] **Step 2: Push committed code to GitHub**

Run:

```bash
git status --short --branch
git push origin main
```

Expected: GitHub main includes the design, retained streaming/resume changes,
and remediation implementation.

- [ ] **Step 3: Preserve dirty VPS state and pull the new code**

Inspect `resume-final-reduction.sh` and `run-final-reduction.sh`, copy or retain
them outside git as needed, then:

```bash
ssh automation-management 'cd /opt/exclusive-motors-au-sku-manage && git stash push -u -m pre-remediation-deploy && git pull --ff-only origin main'
```

Expected: tracked VPS modifications are preserved in a stash and the checkout
advances without deleting `.env` or `catalog-runs`.

- [ ] **Step 4: Build, verify, and run non-mutating plan**

```bash
ssh automation-management 'cd /opt/exclusive-motors-au-sku-manage && bin/catalog build && bin/catalog verify && RUN_DIR=catalog-runs/fix-plan-20260528 bin/catalog fix-plan'
```

Expected: plan artifacts and counts are valid with no store mutation.

- [ ] **Step 5: Run and validate 40-product mutation test**

```bash
ssh automation-management 'cd /opt/exclusive-motors-au-sku-manage && RUN_DIR=catalog-runs/fix-test-40-20260528 bin/catalog fix-test'
```

Expected: operation status complete, no user errors, matching cleaned titles
where applicable, and the test variants report available quantity `10`.

- [ ] **Step 6: Run and validate full remediation**

```bash
ssh automation-management 'cd /opt/exclusive-motors-au-sku-manage && RUN_DIR=catalog-runs/fix-all-20260528 bin/catalog fix-all'
```

Expected: all attempted title mutations are accounted for and all eligible
remaining variants at `Shop location` report available quantity `10`, except
any explicitly recorded compare-and-set conflicts requiring a rerun.

- [ ] **Step 7: Record final outcomes in Context OS Memory**

Save a durable session summary identifying commits, tests, VPS deployment,
downloaded backup location, Shopify operation IDs/counts, verified outcomes,
and any unapplied rows or remaining risks.
