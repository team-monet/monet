export function pickRandom(items) {
  if (!items || items.length === 0) {
    return undefined;
  }
  const index = Math.floor(Math.random() * items.length);
  return items[index];
}

export function authHeaders(seed) {
  const key = pickRandom(seed.apiKeys);
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

export function buildUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

function normalizeTenantSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 63)
    .replace(/-+$/g, "");
}

export function resolveTenantSlug(seed) {
  const fromEnv = normalizeTenantSlug(__ENV.LOAD_TENANT_SLUG);
  if (fromEnv) return fromEnv;

  const fromManifest = normalizeTenantSlug(seed && seed.tenantSlug);
  if (fromManifest) return fromManifest;

  const fromName = normalizeTenantSlug(seed && seed.tenantName);
  if (fromName) return fromName;

  throw new Error(
    "Unable to resolve tenant slug for load tests. Set seed.tenantSlug/tenantName or LOAD_TENANT_SLUG.",
  );
}

export function buildTenantApiUrl(baseUrl, seed, path) {
  const tenantSlug = resolveTenantSlug(seed);
  return buildUrl(baseUrl, `/api/tenants/${tenantSlug}${path}`);
}

export function buildTenantMcpUrl(baseUrl, seed) {
  const tenantSlug = resolveTenantSlug(seed);
  return buildUrl(baseUrl, `/mcp/${tenantSlug}`);
}

export function randomMemoryType() {
  const types = ["decision", "pattern", "issue", "preference", "fact", "procedure"];
  return pickRandom(types);
}
