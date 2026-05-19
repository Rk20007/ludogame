import { NextResponse } from "next/server";

/**
 * @param {unknown} data
 * @param {number} [status=200]
 */
export function jsonSuccess(data = {}, status = 200) {
  return NextResponse.json({ success: true, ...data }, { status });
}

/**
 * @param {string} message
 * @param {number} status
 * @param {unknown} [extra]
 */
export function jsonError(message, status = 400, extra = undefined) {
  const body = { success: false, error: message };
  if (extra !== undefined && extra !== null) {
    body.details = extra;
  }
  return NextResponse.json(body, { status });
}
