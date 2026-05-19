import { NextResponse } from "next/server";
import axios from "axios";
import { connectDB } from "@/lib/db/mongoose.js";
import PaymentTransaction from "@/lib/models/payment-transaction.model.js";
import { getEkqrApiKey, EKQR } from "@/lib/config/ekqr.js";
import { jsonError, jsonSuccess } from "@/lib/utils/response.js";
import { sanitizeTxnId, validateTxnDate } from "@/lib/utils/validators.js";
import { ekqrCheckOrderStatus } from "@/lib/services/ekqr-api.client.js";
import { extractCheckOrderFields } from "@/lib/utils/ekqr-response.js";
import {
  finalizeSuccessfulEkqrPayment,
  isGatewaySuccessStatus,
  markPaymentFailed,
} from "@/lib/services/ekqr-wallet.service.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/payment/check-status
 * Body: client_txn_id, txn_date (DD-MM-YYYY)
 */
export async function POST(request) {
  console.log("[EKQR] check-status: incoming request");

  try {
    /** @type {Record<string, unknown>} */
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonError("Invalid JSON body", 400);
    }

    const client_txn_id = sanitizeTxnId(
      typeof body.client_txn_id === "string" ? body.client_txn_id : ""
    );
    const txn_date = validateTxnDate(
      typeof body.txn_date === "string" ? body.txn_date : ""
    );

    if (!client_txn_id) {
      return jsonError("client_txn_id is required", 400);
    }
    if (!txn_date) {
      return jsonError("txn_date is required as DD-MM-YYYY", 400);
    }

    const key = getEkqrApiKey();
    if (!key) {
      console.error("[EKQR] check-status: missing EKQR_API_KEY / UPI_WEBHOOK_SECRET");
      return jsonError("Payment gateway is not configured", 500);
    }

    await connectDB();

    const doc = await PaymentTransaction.findOne({ client_txn_id });
    if (!doc) {
      return jsonError("Transaction not found for client_txn_id", 404);
    }

    const ekqrBody = { key, client_txn_id, txn_date };

    let apiPayload;
    try {
      const res = await ekqrCheckOrderStatus(EKQR.checkOrderUrl, ekqrBody);
      apiPayload = res.data;
    } catch (err) {
      console.error("[EKQR] check-status: upstream error:", err?.message ?? err);
      /** @type {unknown} */
      let details = undefined;
      if (axios.isAxiosError(err) && err.response?.data !== undefined) {
        details = err.response.data;
      }

      await PaymentTransaction.findByIdAndUpdate(doc._id, {
        failureReason: "check_order_upstream_error",
        rawResponse:
          axios.isAxiosError(err)
            ? { previous: doc.rawResponse, error: details }
            : { previous: doc.rawResponse, error: String(err) },
      }).catch(() => {});

      return jsonError(
        "Failed to check order status",
        502,
        typeof details !== "undefined" ? details : undefined
      );
    }

    const extracted = extractCheckOrderFields(apiPayload);
    await PaymentTransaction.findByIdAndUpdate(doc._id, {
      rawResponse: apiPayload,
      txn_date,
      ...(extracted.order_id ? { order_id: extracted.order_id } : {}),
      ...(extracted.txn_id ? { txn_id: extracted.txn_id } : {}),
    });

    const gatewaySuccess = isGatewaySuccessStatus(extracted.status);

    if (gatewaySuccess) {
      const gwTxn =
        extracted.txn_id?.trim() ||
        doc.txn_id?.trim() ||
        "";

      if (!gwTxn) {
        console.error(
          "[EKQR] check-status: gateway success without txn id",
          apiPayload
        );
        await markPaymentFailed({
          paymentTransactionId: doc._id,
          client_txn_id,
          webhookPayload: { check_status: apiPayload },
          reason: "success_missing_txn_id",
        }).catch(() => {});
        return jsonSuccess(
          {
            status: "failed",
            message: "Gateway status success but txn_id missing — cannot reconcile",
            client_txn_id,
            gateway: extracted,
          },
          200
        );
      }

      const outcome = await finalizeSuccessfulEkqrPayment({
        userId: doc.userId,
        paymentTransactionId: doc._id,
        gatewayTxnId: gwTxn,
        client_txn_id,
        webhookPayload: { check_status: apiPayload },
        source: "check_status",
      });

      if (outcome === "duplicate") {
        console.log("[EKQR] Duplicate Transaction (check_status)");
      } else if (outcome === "credited") {
        console.log("[EKQR] Payment Success (check_status)");
      }

      const fresh = await PaymentTransaction.findById(doc._id).lean();

      return jsonSuccess({
        reconciliation: outcome,
        client_txn_id,
        txn_id: fresh?.txn_id,
        gateway: extracted,
        paymentStatus: fresh?.status,
      });
    }

    await markPaymentFailed({
      paymentTransactionId: doc._id,
      client_txn_id,
      webhookPayload: { check_status: apiPayload },
      reason: "check_status_gateway_not_successful",
    });

    console.log("[EKQR] Payment Failed (check_status)");
    const failed = await PaymentTransaction.findById(doc._id).lean();

    return jsonSuccess({
      reconciliation: "failed",
      client_txn_id,
      gateway: extracted,
      paymentStatus: failed?.status,
    });
  } catch (error) {
    console.error("[EKQR] check-status: unhandled error:", error);
    return NextResponse.json(
      { success: false, error: "Unexpected server error" },
      { status: 500 }
    );
  }
}

export async function GET() {
  return new NextResponse(null, { status: 405 });
}
