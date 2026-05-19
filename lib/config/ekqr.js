/** EKQR / UPIGateway HTTP API base URLs and paths. Keys come from env only. */

export const EKQR = {
  createOrderUrl: process.env.EKQR_CREATE_ORDER_URL || "https://api.ekqr.in/api/create_order",
  checkOrderUrl: process.env.EKQR_CHECK_ORDER_URL || "https://api.ekqr.in/api/check_order_status",
};

/**
 * Merchant API key (EKQR dashboard → Key).
 * Prefer EKQR_API_KEY; fallback UPI_WEBHOOK_SECRET keeps one secret for webhook + REST.
 */
export function getEkqrApiKey() {
  return (
    process.env.EKQR_API_KEY?.trim() ||
    process.env.UPI_WEBHOOK_SECRET?.trim() ||
    ""
  );
}

export function getPaymentRedirectUrl() {
  const url =
    process.env.PAYMENT_REDIRECT_URL?.trim() ||
    process.env.NEXT_PUBLIC_PAYMENT_REDIRECT_URL?.trim() ||
    "";
  return url || "https://example.com/payment-status";
}

const DEFAULT_HTTP_TIMEOUT_MS = 60_000;
const MIN_HTTP_TIMEOUT_MS = 5_000;
const MAX_HTTP_TIMEOUT_MS = 120_000;

/**
 * Millisecond timeout for EKQR HTTP calls (`create_order`, `check_order_status`).
 * Override with `EKQR_HTTP_TIMEOUT_MS` (clamped between 5s and 120s).
 */
export function getEkqrHttpTimeoutMs() {
  const raw = process.env.EKQR_HTTP_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_HTTP_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_HTTP_TIMEOUT_MS;
  return Math.min(Math.max(n, MIN_HTTP_TIMEOUT_MS), MAX_HTTP_TIMEOUT_MS);
}
