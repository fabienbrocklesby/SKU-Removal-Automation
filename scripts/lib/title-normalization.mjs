const SEPARATED_SCRAPED_PREFIX = /^\s*(?:[\/\\|'"'\u2018\u2019\u201c\u201d]+\s+)+/;

export function normalizeCatalogTitle(title) {
  const normalized = title.replace(SEPARATED_SCRAPED_PREFIX, "");
  return {
    changed: normalized !== title,
    title: normalized
  };
}
