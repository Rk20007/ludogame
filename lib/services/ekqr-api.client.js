/**
 * Axios client for EKQR REST endpoints.
 */
import axios from "axios";

import { getEkqrHttpTimeoutMs } from "@/lib/config/ekqr.js";

/**
 * Create EKQR payment order (JSON body).
 */
export async function ekqrCreateOrder(url, body, axiosConfig = {}) {
  return axios.post(url, body, {
    timeout: getEkqrHttpTimeoutMs(),
    headers: { "Content-Type": "application/json" },
    ...axiosConfig,
  });
}

/**
 * Poll EKQR order status (JSON body).
 */
export async function ekqrCheckOrderStatus(url, body, axiosConfig = {}) {
  return axios.post(url, body, {
    timeout: getEkqrHttpTimeoutMs(),
    headers: { "Content-Type": "application/json" },
    ...axiosConfig,
  });
}

/**
 * Normalize nested `{ data: { ... } }` EKQR responses.
 */
export function unwrapEkqrPayload(data) {
  if (!data || typeof data !== "object") return {};
  /** @type {Record<string, unknown>} */
  const inner = /** @type {Record<string, unknown>} */ (
    typeof data.data === "object" && data.data !== null ? data.data : {}
  );
  return { outer: data, inner };
}
