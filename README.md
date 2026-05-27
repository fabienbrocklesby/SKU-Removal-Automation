# Exclusive Motors AU Catalog Cleanup

VPS-ready Shopify Admin GraphQL runner for reducing the Exclusive Motors AU catalog by hard-deleting non-kept products.

The runner is deliberately guarded:

- It refuses to run against any store except `hpas5s-eu.myshopify.com`.
- It exports and hashes backup/audit files before deletion.
- It only deletes when `DELETE_EXCLUSIVE_MOTORS_AU_PRODUCTS` is supplied by the wrapper.
- It supports `--delete-limit 40` for a small live deletion test.
- It shows a terminal progress dashboard for bulk export, backup file writing, and deletion.

## Quick Commands

Create `.env` from `.env.example`, then set the Shopify app client ID/secret and Admin API token.

```bash
cp .env.example .env
bin/catalog build
bin/catalog verify
```

OAuth helpers are local because the browser callback needs to reach your machine:

```bash
bin/catalog oauth-url
bin/catalog oauth
bin/catalog oauth-exchange TEMPORARY_CODE
```

Small smoke-test dry run:

```bash
bin/catalog dry-run-small
```

Delete up to 40 products as a live test:

```bash
bin/catalog delete-test
```

Full backup-only run:

```bash
RUN_DIR=catalog-runs/2026-05-27-overnight KEEP=10000 EXPECTED_PRODUCTS=326820 bin/catalog backup-full
```

Delete the full non-kept set after the test:

```bash
RUN_DIR=catalog-runs/2026-05-27-overnight bin/catalog delete-all
```

## Output Files

Each run writes a timestamped or named directory under `catalog-runs/`.

- `all-products-full.jsonl.gz`: structured restore-grade product backup.
- `all-products-shopify-import.csv`: Shopify-compatible CSV helper.
- `deleted-skus.csv`: variant/SKU audit file for deleted products.
- `deleted-products.csv`: product-level delete list.
- `kept-products.csv`: kept products and their SKUs.
- `delete-input.jsonl`: product IDs sent to Shopify deletion.
- `delete-results.jsonl`: Shopify bulk deletion results.
- `manifest.json`: counts, hashes, timestamps, API version, and operation state.

## VPS Notes

Install Docker and the Compose plugin, clone this repo, create `.env`, then run:

```bash
bin/catalog build
bin/catalog verify
bin/catalog bulk-status
bin/catalog dry-run-small
bin/catalog delete-test
RUN_DIR=catalog-runs/overnight KEEP=10000 EXPECTED_PRODUCTS=326820 bin/catalog backup-full
RUN_DIR=catalog-runs/overnight KEEP=10000 bin/catalog delete-all
```

The wrapper mounts `./catalog-runs` into the container, so backup files remain on the VPS filesystem.

Set `NO_TUI=1` if you need plain log lines instead of the progress dashboard.
