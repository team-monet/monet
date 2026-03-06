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

export function randomMemoryType() {
  const types = ["decision", "pattern", "issue", "preference", "fact", "procedure"];
  return pickRandom(types);
}
