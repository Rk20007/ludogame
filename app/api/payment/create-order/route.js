import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import axios from "axios";
import { connectDB } from "@/lib/db/mongoose.js";
import PaymentTransaction from "@/lib/models/payment-transaction.model.js";
import { getEkqrApiKey, getPaymentRedirectUrl, EKQR } from "@/lib/config/ekqr.js";
import { jsonError, jsonSuccess } from "@/lib/utils/response.js";
import {
  parsePositiveAmount,
  validateObjectId,
} from "@/lib/utils/validators.js";
import { ekqrCreateOrder } from "@/lib/services/ekqr-api.client.js";
import {
  extractCreateOrderFields,
  extractEkqrUpstreamMessage,
} from "@/lib/utils/ekqr-response.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/payment/create-order
 * Body: amount, customer_name, customer_email, customer_mobile, p_info, userId
 */
export async function POST(request) {
  console.log("[EKQR] create-order: incoming request");

  try {
    /** @type {Record<string, unknown>} */
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonError("Invalid JSON body", 400);
    }

    const amountNum = parsePositiveAmount(body.amount);
    const customer_name =
      typeof body.customer_name === "string" ? body.customer_name.trim() : "";
    const customer_email =
      typeof body.customer_email === "string" ? body.customer_email.trim() : "";
    const customer_mobile =
      typeof body.customer_mobile === "string" ? body.customer_mobile.trim() : "";
    const p_info =
      typeof body.p_info === "string"
        ? body.p_info.trim()
        : typeof body.p_info === "number"
          ? String(body.p_info)
          : "";
    const userId = validateObjectId(body.userId);

    if (amountNum === null) {
      return jsonError("amount must be a positive number", 400);
    }
    if (!customer_name || !customer_email || !customer_mobile || !p_info) {
      return jsonError(
        "customer_name, customer_email, customer_mobile, and p_info are required",
        400
      );
    }
    if (!userId) {
      return jsonError("userId must be a valid Mongo ObjectId", 400);
    }

    const key = getEkqrApiKey();
    if (!key) {
      console.error("[EKQR] create-order: missing EKQR_API_KEY / UPI_WEBHOOK_SECRET");
      return jsonError("Payment gateway is not configured", 500);
    }

    await connectDB();

    const client_txn_id =
      `${Date.now()}${uuidv4().replace(/-/g, "").slice(0, 12)}`;

    /** Amount string as required by gateway sample payloads */
    const amountStr = String(amountNum);

    const redirect_url =
      typeof body.redirect_url === "string" && body.redirect_url.trim()
        ? body.redirect_url.trim()
        : getPaymentRedirectUrl();

    const udf1 =
      typeof body.udf1 === "string" && body.udf1.trim()
        ? body.udf1.trim()
        : process.env.EKQR_UDF1?.trim() || "wallet";

    const udf2 =
      typeof body.udf2 === "string" && body.udf2.trim()
        ? body.udf2.trim()
        : String(userId);

    const udf3 =
      typeof body.udf3 === "string" && body.udf3.trim()
        ? body.udf3.trim()
        : process.env.EKQR_UDF3?.trim() || "custom";

    const pendingTx = await PaymentTransaction.create({
      userId,
      amount: amountNum,
      client_txn_id,
      status: "pending",
      payment_url: null,
      p_info,
    });

    const ekqrBody = {
      key,
      client_txn_id,
      amount: amountStr,
      p_info,
      customer_name,
      customer_email,
      customer_mobile,
      redirect_url,
      udf1,
      udf2,
      udf3,
    };

    let apiPayload;
    try {
      const res = await ekqrCreateOrder(EKQR.createOrderUrl, ekqrBody);
      apiPayload = res.data;
    } catch (err) {
      console.error("[EKQR] create-order: upstream error:", err?.message ?? err);

      /** @type {unknown} */
      let details = undefined;
      if (axios.isAxiosError(err) && err.response?.data !== undefined) {
        details = err.response.data;
      }

      await PaymentTransaction.findByIdAndUpdate(pendingTx._id, {
        status: "failed",
        failureReason: "create_order_upstream_error",
        rawResponse:
          axios.isAxiosError(err)
            ? { message: err.message, data: details }
            : { message: String(err) },
      }).catch(() => {});

      return jsonError(
        "Failed to create payment order",
        502,
        typeof details !== "undefined" ? details : undefined
      );
    }

    const { payment_url, order_id } = extractCreateOrderFields(apiPayload);

    if (!payment_url) {
      console.error("[EKQR] create-order: missing_payment_url in response", apiPayload);
      await PaymentTransaction.findByIdAndUpdate(pendingTx._id, {
        status: "failed",
        failureReason: "missing_payment_url",
        rawResponse: apiPayload,
      }).catch(() => {});
      const upstreamMsg = extractEkqrUpstreamMessage(apiPayload);
      return jsonError(
        upstreamMsg || "Invalid response from payment gateway",
        502,
        apiPayload ?? null
      );
    }

    await PaymentTransaction.findByIdAndUpdate(pendingTx._id, {
      order_id,
      payment_url,
      rawResponse: apiPayload,
    });

    console.log("[EKQR] create-order: success", client_txn_id);

    return jsonSuccess(
      {
        payment_url,
        order_id,
        client_txn_id,
      },
      200
    );
  } catch (error) {
    console.error("[EKQR] create-order: unhandled error:", error);
    return NextResponse.json(
      { success: false, error: "Unexpected server error" },
      { status: 500 }
    );
  }
}

export async function GET() {
  return new NextResponse(null, { status: 405 });
}
