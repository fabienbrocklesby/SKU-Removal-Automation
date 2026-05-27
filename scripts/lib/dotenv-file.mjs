const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
const MANAGED_KEYS = [
  "SHOPIFY_ADMIN_API_DOMAIN",
  "SHOPIFY_ADMIN_API_ACCESS_TOKEN",
  "SHOPIFY_ADMIN_API_VERSION",
  "SHOPIFY_APP_CLIENT_ID",
  "SHOPIFY_APP_CLIENT_SECRET",
  "SHOPIFY_OAUTH_REDIRECT_URI"
];

export function parseEnvContent(content) {
  const env = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const [rawKey, ...valueParts] = line.split("=");
    const key = rawKey.trim();
    if (!ENV_KEY_RE.test(key)) continue;
    env[key] = unquoteEnvValue(valueParts.join("=").trim());
  }
  return env;
}

export async function loadEnvFile(path = ".env") {
  const { readFile } = await import("node:fs/promises");
  let content = "";
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return {};
  }

  const parsed = parseEnvContent(content);
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return parsed;
}

export function upsertEnvBlock(content, values) {
  const keysToReplace = new Set([...MANAGED_KEYS, ...Object.keys(values)]);
  const keptLines = content
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) return true;
      const key = trimmed.split("=", 1)[0].trim();
      return !keysToReplace.has(key);
    })
    .filter((line, index, lines) => !(line.trim() === "" && lines[index - 1]?.trim() === ""));

  const block = [
    "# Exclusive Motors AU catalog cleanup",
    ...Object.entries(values).map(([key, value]) => `${key}=${quoteEnvValue(value)}`)
  ];

  const prefix = keptLines.join("\n").trimEnd();
  return `${prefix ? `${prefix}\n\n` : ""}${block.join("\n")}\n`;
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function quoteEnvValue(value) {
  const text = String(value ?? "");
  if (/[\s#"'\\]/.test(text)) {
    return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  }
  return text;
}
