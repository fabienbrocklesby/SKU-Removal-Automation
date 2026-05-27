# Exclusive Motors AU Catalog Remediation Design

## Purpose

After the catalog reduction completed on 2026-05-27, the store retains 10,000
products but many retained listings have malformed title prefixes and zero
available inventory. Extend the existing VPS-ready catalog CLI to correct those
remaining products safely from the server.

The user authorized implementation and live execution with a mandatory
40-product live validation before the full run. No manual title review queue is
required.

## Existing Context

- The CLI is a Node.js/Docker runner locked to
  `hpas5s-eu.myshopify.com` and uses Shopify Admin GraphQL API `2026-01`.
- It already writes hashed backup and audit files before catalog deletion and
  requires a deliberate mutation command.
- The VPS checkout is `/opt/exclusive-motors-au-sku-manage` through SSH alias
  `automation-management`.
- The completed server run
  `catalog-runs/final-10000-20260527-075502` exported 327,054 products,
  deleted 317,054 products, and retained 10,000.
- The VPS and local checkout contain matching uncommitted low-memory
  streaming/resume improvements from that deletion run. Deployment must
  preserve and commit those changes rather than overwrite them.
- A read-only live query on 2026-05-28 found one active fulfillment location:
  `Shop location` (`gid://shopify/Location/90543390932`).

## Approaches Considered

### Chosen: one plan export, two parallel Shopify bulk applies

Export the remaining products once, produce a remediation plan and restore
artifacts, then submit independent title and inventory bulk mutations. Shopify
Admin API `2026-01` permits up to five simultaneous bulk mutation operations per
shop, so title and inventory mutation jobs can execute concurrently while using
the same source snapshot.

This option fits the existing CLI architecture, is efficient for 10,000
products, and leaves auditable inputs and results.

### Rejected: thousands of synchronous mutation requests

This is easier to prototype but slower and more vulnerable to interruption and
API throttling during a VPS run. It is not appropriate for the full catalog.

### Rejected: generate a CSV for manual Shopify import

This would create a re-upload file but would move live execution out of the
existing guarded CLI, provide weaker execution tracking, and require manual
handling the user did not ask for.

## Commands And Workflow

Extend `bin/catalog` with remediation commands:

- `fix-test [RUN_DIR]`: export a deterministic sample of 40 remaining products,
  build audit/mutation files, apply title and inventory changes for that sample,
  and verify the resulting live records.
- `fix-all [RUN_DIR]`: export all remaining products, build audit/mutation
  files, apply title and inventory changes, and verify counts/results.
- `fix-plan [RUN_DIR]`: produce the same export and mutation/audit files
  without submitting mutations, useful for diagnostics and reruns.

Each mutating command remains store-locked and uses an explicit internal
confirmation value in the wrapper, mirroring deletion safety. The live sequence
is:

1. Deploy committed changes to the VPS without touching `catalog-runs` or
   `.env`.
2. Build and verify the Docker runner against the locked store.
3. Run `fix-test` and inspect its completed mutation results and live
   verification.
4. Run `fix-all` only when the test job has no user errors and verification
   confirms expected behavior.

## Title Normalization

The cleanup is automatic and intentionally conservative.

Strip one or more leading scraped punctuation characters only when the prefix
is separated from the actual title text by whitespace. The removable prefix
set is slash, backslash, straight/smart single quote, straight/smart double
quote, and pipe. Leading whitespace is normalized as part of a changed title.

Examples that change:

| Before | After |
| --- | --- |
| `/ Fuel Filter` | `Fuel Filter` |
| `' Fuel Filter` | `Fuel Filter` |
| `//   Fuel Filter` | `Fuel Filter` |
| `| " Brake Pad` | `Brake Pad` |

Examples that remain unchanged:

| Title | Reason |
| --- | --- |
| `.874" Retrofit Kit` | Decimal/specification prefix |
| `-3 AN Hose` | Technical size prefix |
| `/AN Fitting` | Prefix is attached to product text |
| `+12V Relay` | Technical prefix outside cleanup set |

Do not generate a manual review queue. Generate an audit CSV containing every
automatic title change with product ID, handle, old title, and new title so
the applied change remains traceable and reversible.

## Inventory Correction

For every retained product variant with an inventory item, set the Shopify
`available` quantity to `10` at the single active online location,
`gid://shopify/Location/90543390932`.

The plan export must capture the inventory item ID and the available quantity
seen before application. Live schema introspection for `2026-01` confirmed the
quantity input supports `changeFromQuantity`. The mutation must use Shopify's
absolute `inventorySetQuantities` operation, batching no more than 250
inventory items per input row, with an idempotency key per row and
`changeFromQuantity` for each item. A compare mismatch is recorded as an
unapplied row instead of overwriting an inventory change made after the plan
export.

Inventory audit output records product, variant, inventory item, location,
quantity before, intended quantity, mutation outcome, and any Shopify
user-error code/message.

## Components

- `scripts/lib/title-normalization.mjs`: pure title normalization and
  change-classification functions.
- `scripts/lib/remediation-plan.mjs`: pure construction of title and inventory
  plan records and JSONL mutation variables.
- `scripts/catalog-remediation.mjs`: Shopify export, artifact writing,
  staged-upload/bulk-operation execution, result retrieval, and verification.
- `bin/catalog`: Docker wrapper commands for `fix-plan`, `fix-test`, and
  `fix-all`.
- `README.md`: operator instructions, output descriptions, and deployment/run
  order.
- `tests/title-normalization.test.mjs` and
  `tests/remediation-plan.test.mjs`: regression coverage for protected
  technical prefixes, malformed prefix removal, inventory plan generation,
  and mutation safety flags.

Existing deletion tooling remains functional. Reusable GraphQL, export,
progress, or artifact helpers may be extracted only where needed to avoid
duplicating live-operation code.

## Artifacts

Each remediation run writes under `catalog-runs/<run-name>/`:

- `remediation-export.jsonl.gz`: compressed pre-change snapshot sufficient for
  auditing affected records.
- `title-changes.csv`: automatically applied title before/after values.
- `title-mutation-input.jsonl` and `title-mutation-results.jsonl`.
- `inventory-changes.csv`: quantity before/intended/result values.
- `inventory-mutation-input.jsonl` and `inventory-mutation-results.jsonl`.
- `manifest.json`: store identity, location, product/variant counts, skipped
  counts, hashes, operation IDs/statuses, timestamps, and verification result.

The already completed deletion-run restore/audit deliverables are copied to
local ignored storage under
`catalog-runs/server-final-10000-20260527-075502/`; the multi-gigabyte raw
intermediate exports remain preserved on the VPS unless separately needed.

## Failure Handling And Safety

- Refuse to run unless the configured store matches the locked Exclusive Motors
  AU myshopify domain.
- Do not mutate until plan artifacts have been written and hashed.
- Refuse to stage any mutation JSONL file that exceeds Shopify's documented
  100 MB bulk import limit.
- Fail the 40-product test if either bulk mutation returns Shopify user errors
  or live verification differs from the intended result.
- Do not begin `fix-all` after a failed test.
- Record per-row failures and completed operation URLs/statuses in the
  manifest; never silently report a partial bulk operation as success.
- Keep deletion backup folders and `.env` out of git and untouched during VPS
  deployment.
- Before `git pull` on the VPS, reconcile its currently dirty tracked files and
  preserve its untracked operator scripts.

## Testing And Verification

Implementation uses test-first development for pure title and plan behavior.
Automated tests cover malformed and valid prefix cases, no-op titles, mutation
input generation, inventory location/quantity values, and dry-plan artifacts.

Live validation is staged:

1. Run API-access verification and a non-mutating remediation plan.
2. Apply and verify exactly 40 products with `fix-test`.
3. Apply the complete remaining catalog only after the test verification is
   clean.
4. Fetch mutation result files and run post-apply verification reporting title
   changes and variants with available quantity other than `10`.

## Reference Documentation

- Shopify bulk import operations:
  https://shopify.dev/docs/api/usage/bulk-operations/imports
- Shopify Admin GraphQL `inventorySetQuantities` (`2026-01`):
  https://shopify.dev/docs/api/admin-graphql/2026-01/mutations/inventorySetQuantities
