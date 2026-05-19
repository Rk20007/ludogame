/** Best-effort field extraction for variable EKQR JSON shapes */

import { unwrapEkqrPayload } from "../services/ekqr-api.client.js";

/**
 * Human-readable error text when create_order succeeds over HTTP but omits payment_url.
 * @param {unknown} apiData
 */
export function extractEkqrUpstreamMessage(apiData) {
  const { outer, inner } = unwrapEkqrPayload(apiData);
  /** @type {Record<string, unknown>} */
  const merged = { ...outer, ...inner };
  const errors =
    typeof merged.errors === "string"
      ? merged.errors
      : merged.errors !== undefined &&
          merged.errors !== null &&
          typeof merged.errors === "object"
        ? pickString(JSON.stringify(merged.errors))
        : null;
  return pickString(
    merged.user_msg,
    merged.msg,
    merged.message,
    merged.error,
    errors
  );
}

export function extractCreateOrderFields(apiData) {
  const { outer, inner } = unwrapEkqrPayload(apiData);
  /** @type {Record<string, unknown>} */
  const merged = { ...outer, ...inner };

  const payment_url = pickString(
    merged.payment_url,
    merged.pay_url,
    merged.paymentUrl,
    merged.url
  );
  const order_id = pickString(merged.order_id, merged.orderId, merged.oid);

  return { payment_url, order_id };
}

/**
 * @param {unknown} apiData
 */
export function extractCheckOrderFields(apiData) {
  const { outer, inner } = unwrapEkqrPayload(apiData);
  /** @type {Record<string, unknown>} */
  const merged = { ...outer, ...inner };

  const status =
    merged.status ??
    merged.payment_status ??
    merged.txn_status ??
    merged.state;
  const txn_id = pickString(merged.txn_id, merged.txnid, merged.gateway_txn_id);
  const order_id = pickString(merged.order_id, merged.orderId);

  return { status, txn_id, order_id };
}

/**
 * @param {...unknown} args
 */
function pickString(...args) {
  for (const arg of args) {
    if (arg === undefined || arg === null) continue;
    const s = String(arg).trim();
    if (s) return s;
  }
  return null;
}

export { unwrapEkqrPayload };
