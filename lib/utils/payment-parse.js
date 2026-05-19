/**
 * @param {unknown} raw
 */
export function parseAmount(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number.parseFloat(String(raw));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * @param {string|undefined} value
 */
export function normalizeStatus(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim().toLowerCase();
}
