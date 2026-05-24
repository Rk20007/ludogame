require("dotenv").config();
const axios = require("axios");

const DEFAULT_CREATE_ORDER = "https://api.ekqr.in/api/create_order";
const DEFAULT_CHECK_ORDER = "https://api.ekqr.in/api/check_order_status";

function getEkqrApiKey() {
  return (
    (process.env.EKQR_API_KEY || process.env.UPI_WEBHOOK_SECRET || "").trim() ||
    null
  );
}

function getCreateOrderUrl() {
  return (process.env.EKQR_CREATE_ORDER_URL || DEFAULT_CREATE_ORDER).trim();
}

function getCheckOrderUrl() {
  return (process.env.EKQR_CHECK_ORDER_URL || DEFAULT_CHECK_ORDER).trim();
}

const DEFAULT_HTTP_TIMEOUT_MS = 60_000;
const MIN_HTTP_TIMEOUT_MS = 5_000;
const MAX_HTTP_TIMEOUT_MS = 120_000;

function getEkqrHttpTimeoutMs() {
  const raw = String(process.env.EKQR_HTTP_TIMEOUT_MS || "").trim();
  if (!raw) return DEFAULT_HTTP_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_HTTP_TIMEOUT_MS;
  return Math.min(Math.max(n, MIN_HTTP_TIMEOUT_MS), MAX_HTTP_TIMEOUT_MS);
}

function getDefaultRedirectUrl() {
  const u =
    (process.env.PAYMENT_REDIRECT_URL || "").trim() ||
    (process.env.NEXT_PUBLIC_PAYMENT_REDIRECT_URL || "").trim();
  return u || "https://example.com/payment-status";
}

function unwrapPayload(data) {
  if (!data || typeof data !== "object") {
    return { merged: {}, raw: data };
  }
  const inner =
    typeof data.data === "object" && data.data !== null ? data.data : {};
  const merged = { ...data, ...inner };
  return { merged, raw: data };
}

/** Human-readable upstream message when payment_url is absent (see lib/utils/ekqr-response.js). */
function extractEkqrUpstreamMessage(data) {
  const { merged } = unwrapPayload(data);
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

function extractCreateOrder(data) {
  const { merged } = unwrapPayload(data);
  const payment_url =
    pickString(
      merged.payment_url,
      merged.pay_url,
      merged.paymentUrl,
      merged.url
    ) || null;
  const order_id =
    pickString(merged.order_id, merged.orderId, merged.oid) || null;
  return { payment_url, order_id, merged };
}

function extractCheckOrder(data) {
  const { merged } = unwrapPayload(data);
  const status =
    merged.status ??
    merged.payment_status ??
    merged.txn_status ??
    merged.state;
  const txn_id = pickString(merged.txn_id, merged.txnid, merged.gateway_txn_id);
  const order_id = pickString(merged.order_id, merged.orderId);
  return {
    status: status !== undefined && status !== null ? String(status) : "",
    txn_id,
    order_id,
    merged,
  };
}

function normalizeStatus(raw) {
  if (raw === undefined || raw === null) return "";
  return String(raw).trim().toLowerCase();
}

function isGatewaySuccess(raw) {
  const s = normalizeStatus(raw);
  return (
    s === "success" ||
    s === "successful" ||
    s === "completed" ||
    s === "paid" ||
    s === "captured" ||
    s === "1" ||
    s === "true"
  );
}

/** True if EKQR check_order / webhook payload indicates payment success. */
function isCheckoutSuccessful(extracted, rawData) {
  if (extracted && isGatewaySuccess(extracted.status)) return true;

  const { merged } = unwrapPayload(rawData);
  if (merged.success === true) return true;
  if (normalizeStatus(merged.success) === "true") return true;

  return (
    isGatewaySuccess(merged.status) ||
    isGatewaySuccess(merged.payment_status) ||
    isGatewaySuccess(merged.txn_status) ||
    isGatewaySuccess(merged.state)
  );
}

/** DD-MM-YYYY for EKQR check_order_status (order creation date). */
function formatTxnDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

async function ekqrPost(url, payload) {
  return axios.post(url, payload, {
    timeout: getEkqrHttpTimeoutMs(),
    headers: { "Content-Type": "application/json" },
  });
}

function pickString(...args) {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === undefined || a === null) continue;
    const s = String(a).trim();
    if (s) return s;
  }
  return null;
}

module.exports = {
  getEkqrApiKey,
  getCreateOrderUrl,
  getCheckOrderUrl,
  getDefaultRedirectUrl,
  ekqrPost,
  extractCreateOrder,
  extractEkqrUpstreamMessage,
  extractCheckOrder,
  normalizeStatus,
  isGatewaySuccess,
  isCheckoutSuccessful,
  formatTxnDate,
  unwrapPayload,
};
