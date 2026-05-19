import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db/mongoose.js";
import PaymentTransaction from "@/lib/models/payment-transaction.model.js";
import {
  finalizeSuccessfulEkqrPayment,
  markPaymentFailed,
} from "@/lib/services/ekqr-wallet.service.js";
import { normalizeStatus, parseAmount } from "@/lib/utils/payment-parse.js";
import { sanitizeTxnId } from "@/lib/utils/validators.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Expected shared secret from env. `UPI_WEBHOOK_SECRET` or `EKQR_API_KEY` (EKQR dashboard Key).
 */
function getConfiguredWebhookSecret() {
  return (
    process.env.UPI_WEBHOOK_SECRET?.trim() ||
    process.env.EKQR_API_KEY?.trim() ||
    ""
  );
}

/**
 * Validates API key sent in headers or form body (`api_key`, `key`), after `request.formData()`.
 */
function validateWebhookSecret(request, payload) {
  const secret = getConfiguredWebhookSecret();
  if (!secret) {
    return { ok: true, skipped: true };
  }

  const headerSecret =
    request.headers.get("x-webhook-secret") ||
    request.headers.get("x-api-key") ||
    request.headers.get("api-key");

  const auth = request.headers.get("authorization");
  const bearer =
    auth && auth.toLowerCase().startsWith("bearer ")
      ? auth.slice(7).trim()
      : null;

  const bodyKey = payload.api_key?.trim() || payload.key?.trim();

  const provided = headerSecret || bearer || bodyKey;
  if (!provided || provided !== secret) {
    return { ok: false, skipped: false };
  }

  return { ok: true, skipped: false };
}

function formDataToPlainObject(formData) {
  /** @type {Record<string, string>} */
  const payload = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string") {
      payload[key] = value;
    } else if (value instanceof File) {
      payload[key] = `[file:${value.name}:${value.size}]`;
    } else {
      payload[key] = String(value);
    }
  }
  return payload;
}

function jsonResponse(body, status) {
  return NextResponse.json(body, { status });
}

/** Fields we expect per EKQR / UPIGateway sample (validated subset). */
const WEBHOOK_LOG_FIELDS = [
  "amount",
  "client_txn_id",
  "customer_email",
  "customer_mobile",
  "customer_name",
  "customer_vpa",
  "id",
  "p_info",
  "payment_mode",
  "status",
  "txnAt",
  "txn_id",
  "udf1",
  "udf2",
  "udf3",
  "redirect_url",
  "createdAt",
];

/**
 * POST EKQR / UPIGateway webhook — `application/x-www-form-urlencoded` via `request.formData()`.
 */
export async function POST(request) {
  console.log("Webhook Received");

  try {
    /** @type {FormData} */
    let formData;
    try {
      formData = await request.formData();
    } catch (err) {
      console.error("[UPI Webhook] Invalid form body:", err);
      return jsonResponse(
        { success: false, error: "Invalid form payload" },
        400
      );
    }

    const payload = formDataToPlainObject(formData);

    const snapshot = WEBHOOK_LOG_FIELDS.reduce(
      /** @type {(acc: Record<string, string>, k: string) => Record<string, string>} */
      (acc, k) => {
        if (payload[k] !== undefined) acc[k] = payload[k];
        return acc;
      },
      {}
    );

    console.log("[UPI Webhook] Parsed payload snapshot:", JSON.stringify(snapshot));
    console.log("[UPI Webhook] Full raw keys:", JSON.stringify(Object.keys(payload)));

    const secretCheck = validateWebhookSecret(request, payload);
    if (!secretCheck.ok) {
      console.error("[UPI Webhook] Unauthorized: invalid gateway key");
      return jsonResponse({ success: false, error: "Unauthorized" }, 401);
    }

    const txn_id = sanitizeTxnId(payload.txn_id);
    const client_txn_id = sanitizeTxnId(payload.client_txn_id);
    const amountNum = parseAmount(payload.amount);
    const statusRaw = payload.status ?? "";

    if (!txn_id) {
      console.error("[UPI Webhook] Validation failed: missing txn_id");
      return jsonResponse(
        { success: false, error: "txn_id is required" },
        400
      );
    }

    if (!client_txn_id) {
      console.error("[UPI Webhook] Validation failed: missing client_txn_id");
      return jsonResponse(
        { success: false, error: "client_txn_id is required" },
        400
      );
    }

    if (amountNum === null) {
      console.error("[UPI Webhook] Validation failed: invalid amount");
      return jsonResponse(
        {
          success: false,
          error: "amount is required and must be a positive number",
        },
        400
      );
    }

    if (statusRaw === undefined || statusRaw === null || !String(statusRaw).trim()) {
      console.error("[UPI Webhook] Validation failed: missing status");
      return jsonResponse(
        { success: false, error: "status is required" },
        400
      );
    }

    await connectDB();

    const normalizedStatus = normalizeStatus(statusRaw);

    const pt = await PaymentTransaction.findOne({ client_txn_id });
    if (!pt) {
      console.error(
        "[UPI Webhook] Unknown client_txn_id — no pending PaymentTransaction"
      );
      return jsonResponse(
        { success: false, error: "Unknown transaction" },
        404
      );
    }

    if (
      pt.amount !== undefined &&
      typeof pt.amount === "number" &&
      Math.abs(pt.amount - amountNum) > 0.015
    ) {
      console.warn(
        `[UPI Webhook] Amount mismatch webhook=${amountNum} stored=${pt.amount} — proceeding with stored amount on credit`
      );
    }

    await PaymentTransaction.findByIdAndUpdate(pt._id, {
      webhookPayload: payload,
      txn_id,
    }).catch(() => {});

    if (normalizedStatus !== "success") {
      await markPaymentFailed({
        paymentTransactionId: pt._id,
        client_txn_id,
        webhookPayload: payload,
        reason: "webhook_gateway_status_not_success",
      }).catch(() => {});
      console.log("Payment Failed");
      return jsonResponse({ success: true }, 200);
    }

    const outcome = await finalizeSuccessfulEkqrPayment({
      userId: pt.userId,
      paymentTransactionId: pt._id,
      gatewayTxnId: txn_id,
      client_txn_id,
      webhookPayload: payload,
      source: "webhook",
    });

    if (outcome === "duplicate") {
      console.log("Duplicate Transaction");
    } else if (outcome === "credited") {
      console.log("Payment Success");
    } else if (
      outcome === "missing_user" ||
      outcome === "missing_user_id" ||
      outcome === "missing_payment_row"
    ) {
      console.log("Payment Failed");
    }

    return jsonResponse({ success: true }, 200);
  } catch (error) {
    console.error("[UPI Webhook] Unhandled error:", error);
    return jsonResponse({ success: true }, 200);
  }
}

/** @param {Request} request */
export async function GET(request) {
  void request;
  return new NextResponse(null, { status: 405 });
}

export async function PUT() {
  return new NextResponse(null, { status: 405 });
}

export async function DELETE() {
  return new NextResponse(null, { status: 405 });
}

export async function PATCH() {
  return new NextResponse(null, { status: 405 });
}
