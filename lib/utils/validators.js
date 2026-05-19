import mongoose from "mongoose";

/**
 * @param {unknown} raw
 */
export function parsePositiveAmount(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number.parseFloat(String(raw));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * @param {unknown} id
 */
export function validateObjectId(id) {
  const s = id === undefined || id === null ? "" : String(id).trim();
  if (!s || !mongoose.Types.ObjectId.isValid(s)) return null;
  return new mongoose.Types.ObjectId(s);
}

/**
 * @param {string|undefined|null} txnId
 */
export function sanitizeTxnId(txnId) {
  if (txnId === undefined || txnId === null) return "";
  return String(txnId).trim();
}

/**
 * DD-MM-YYYY for EKQR check_order_status
 * @param {string|undefined|null} input
 */
export function validateTxnDate(input) {
  const s = input === undefined || input === null ? "" : String(input).trim();
  if (!s) return null;
  if (!/^\d{2}-\d{2}-\d{4}$/.test(s)) return null;
  return s;
}
