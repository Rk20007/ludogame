const axios = require("axios");
const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const User = require("../models/user.model");
const Transaction = require("../models/transaction.model");
const { GatewayPayment } = require("../models/gatewayPayment.model");
const { errorHandler, successHandler } = require("../utils/responseHandler");
const {
  getEkqrApiKey,
  getCreateOrderUrl,
  getCheckOrderUrl,
  getDefaultRedirectUrl,
  ekqrPost,
  extractCreateOrder,
  extractEkqrUpstreamMessage,
  extractCheckOrder,
  isGatewaySuccess,
  isCheckoutSuccessful,
  formatTxnDate,
} = require("../utils/ekqrGateway.helper");
const {
  validateEkqrWebhookKey,
  stringifyWebhookPayload,
  markGatewayPaymentFailed,
  finalizeSuccessfulGatewayPayment,
  createPendingGatewayRecharge,
  appendClientTxnToRedirectUrl,
} = require("../utils/gatewayPaymentWallet.service");

function parsePositiveAmount(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number.parseFloat(String(raw));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function validateTxnDate(s) {
  const t =
    typeof s === "string" ? s.trim() : s === undefined ? "" : String(s).trim();
  if (!t) return null;
  if (!/^\d{2}-\d{2}-\d{4}$/.test(t)) return null;
  return t;
}

function sanitizeString(v) {
  if (typeof v !== "string") return "";
  return v.trim();
}

function resolveGatewayTxnId(extracted, gp, client_txn_id) {
  const fromApi =
    extracted?.txn_id && String(extracted.txn_id).trim()
      ? String(extracted.txn_id).trim()
      : "";
  const fromGp =
    gp?.txn_id && String(gp.txn_id).trim() ? String(gp.txn_id).trim() : "";
  const cid = sanitizeString(client_txn_id) || sanitizeString(gp?.client_txn_id);
  if (fromApi) return fromApi;
  if (fromGp) return fromGp;
  if (cid) return `client_${cid}`;
  return "";
}

async function buildSettlementPayload(gp, client_txn_id, outcome, extra = {}) {
  const refreshed = await GatewayPayment.findOne({ client_txn_id }).lean();
  const settledTxn = await Transaction.findOne({ gatewayPaymentId: gp._id })
    .select("status isAutoApproved approvalSource")
    .lean();
  const user = await User.findById(gp.userId, { balance: 1 }).lean();

  return {
    client_txn_id,
    reconciliation: outcome,
    txn_id: refreshed?.txn_id ?? null,
    walletCredited: refreshed?.walletCredited ?? false,
    transactionStatus: settledTxn?.status ?? null,
    isAutoApproved: settledTxn?.isAutoApproved ?? false,
    approvalSource: settledTxn?.approvalSource ?? null,
    userWalletBalance: user?.balance?.totalWalletBalance ?? null,
    ...extra,
  };
}

/**
 * POST /api/payment/create-order
 */
const createOrder = async (req, res) => {
  console.log("[EKQR] create-order");
  try {
    const apiKey = getEkqrApiKey();
    if (!apiKey) {
      console.error("[EKQR] Missing EKQR_API_KEY / UPI_WEBHOOK_SECRET");
      return errorHandler({
        res,
        statusCode: 500,
        message: "Gateway key not configured on server",
      });
    }

    const {
      amount,
      customer_name,
      customer_email,
      customer_mobile,
      p_info,
      userId,
      redirect_url,
      udf1,
      udf2,
      udf3,
    } = req.body || {};

    const amountNum = parsePositiveAmount(amount);

    if (amountNum === null) {
      return errorHandler({
        res,
        statusCode: 400,
        message: "amount must be a positive number",
      });
    }

    if (amountNum < 10) {
      return errorHandler({
        res,
        statusCode: 400,
        message: "Minimum add cash amount is 10",
      });
    }

    const tokenUid = sanitizeString(req.user && req.user._id);
    const bodyUserId = sanitizeString(userId);
    const normalizedUserId =
      req.user.role === "admin" && bodyUserId
        ? bodyUserId
        : tokenUid;

    if (!normalizedUserId || !mongoose.Types.ObjectId.isValid(normalizedUserId)) {
      return errorHandler({
        res,
        statusCode: 400,
        message: "Valid authenticated user required",
      });
    }

    if (
      tokenUid &&
      normalizedUserId &&
      tokenUid !== normalizedUserId &&
      req.user.role !== "admin"
    ) {
      return errorHandler({
        res,
        statusCode: 403,
        message: "Forbidden: userId does not match authenticated user",
      });
    }

    const payer = await User.findOne(
      { _id: normalizedUserId, isActive: true },
      { name: 1, email: 1, mobileNo: 1, balance: 1 }
    ).lean();

    if (!payer) {
      return errorHandler({
        res,
        statusCode: 404,
        message: "User not found or inactive",
      });
    }

    const cName =
      sanitizeString(customer_name) || payer.name || "Wallet User";
    const cMobile =
      sanitizeString(customer_mobile) || payer.mobileNo || "";
    const cEmail =
      sanitizeString(customer_email) ||
      payer.email ||
      (cMobile ? `${cMobile}@wallet.local` : "wallet@local.invalid");
    const pInfo = sanitizeString(p_info || "") || "Wallet Add Cash";

    if (!cMobile || !/^\d{10}$/.test(cMobile)) {
      return errorHandler({
        res,
        statusCode: 400,
        message: "Valid 10-digit customer_mobile is required on user profile",
      });
    }

    const client_txn_id = `${Date.now()}${uuidv4().replace(/-/g, "").slice(0, 12)}`;
    const redirBase =
      typeof redirect_url === "string" && redirect_url.trim()
        ? redirect_url.trim()
        : getDefaultRedirectUrl();
    const redir = appendClientTxnToRedirectUrl(redirBase, client_txn_id);

    const gp = await GatewayPayment.create({
      userId: normalizedUserId,
      amount: amountNum,
      client_txn_id,
      status: "pending",
      p_info: pInfo,
      payment_url: null,
      order_id: null,
      rawResponse: null,
      webhookPayload: null,
      walletCredited: false,
    });

    const udfWallet =
      typeof udf1 === "string" && udf1.trim() ? udf1.trim() : "wallet";
    const udfUser =
      typeof udf2 === "string" && udf2.trim() ? udf2.trim() : normalizedUserId;
    const udfExtra =
      typeof udf3 === "string" && udf3.trim() ? udf3.trim() : "custom";

    const payload = {
      key: apiKey,
      client_txn_id,
      amount: String(amountNum),
      p_info: pInfo,
      customer_name: cName,
      customer_email: cEmail,
      customer_mobile: cMobile,
      redirect_url: redir,
      udf1: udfWallet,
      udf2: udfUser,
      udf3: udfExtra,
    };

    let upstream;
    try {
      upstream = await ekqrPost(getCreateOrderUrl(), payload);
    } catch (err) {
      console.error("[EKQR] create_order upstream error:", err?.message ?? err);

      /** @type {unknown} */
      let details = err && axios.isAxiosError(err) ? err.response?.data : undefined;
      await GatewayPayment.findByIdAndUpdate(gp._id, {
        status: "failed",
        failureReason: "create_order_upstream_error",
        rawResponse:
          err && axios.isAxiosError(err)
            ? { message: err.message, upstream: details ?? null }
            : { message: String(err) },
      }).catch(() => {});

      return errorHandler({
        res,
        statusCode: 502,
        message: "Upstream create_order failed",
      });
    }

    const { payment_url, order_id } = extractCreateOrder(upstream.data);

    if (!payment_url) {
      console.error("[EKQR] create_order missing payment_url", upstream?.data);
      await GatewayPayment.findByIdAndUpdate(gp._id, {
        status: "failed",
        failureReason: "missing_payment_url",
        rawResponse: upstream?.data ?? null,
      }).catch(() => {});

      const upstreamMsg = extractEkqrUpstreamMessage(upstream?.data);
      return errorHandler({
        res,
        statusCode: 502,
        message:
          upstreamMsg ||
          "Invalid upstream response — payment_url missing",
      });
    }

    await GatewayPayment.findByIdAndUpdate(gp._id, {
      payment_url,
      order_id,
      rawResponse: upstream?.data ?? null,
    });

    let pendingRecharge = null;
    try {
      pendingRecharge = await createPendingGatewayRecharge({
        userId: normalizedUserId,
        amount: amountNum,
        gatewayPaymentId: gp._id,
        client_txn_id,
        userSnapshot: payer,
      });
    } catch (pendingErr) {
      console.error("[EKQR] pending recharge row error:", pendingErr);
    }

    console.log("[EKQR] create-order ok", client_txn_id);

    return successHandler({
      res,
      statusCode: 201,
      message: "Payment order created",
      data: {
        payment_url,
        order_id,
        client_txn_id,
        transactionId: pendingRecharge?._id ?? null,
        rechargeStatus: "pending",
      },
    });
  } catch (e) {
    console.error("[EKQR] create-order error:", e);
    return errorHandler({
      res,
      statusCode: 500,
      message: "Internal server error",
    });
  }
};

/**
 * POST /api/payment/check-status
 * POST /api/payment/reconcile (same logic — txn_date optional, defaults to order date)
 */
async function runGatewayCheckAndSettle(req, res) {
  console.log("[EKQR] check-status / reconcile");
  try {
    const apiKey = getEkqrApiKey();
    if (!apiKey) {
      console.error("[EKQR] Missing EKQR_API_KEY / UPI_WEBHOOK_SECRET");
      return errorHandler({
        res,
        statusCode: 500,
        message: "Gateway key not configured on server",
      });
    }

    const client_txn_id = sanitizeString((req.body && req.body.client_txn_id) || "");

    if (!client_txn_id) {
      return errorHandler({
        res,
        statusCode: 400,
        message: "client_txn_id is required",
      });
    }

    const gp = await GatewayPayment.findOne({ client_txn_id }).lean();

    if (!gp) {
      return errorHandler({
        res,
        statusCode: 404,
        message: "Unknown client_txn_id — create-order must be called on this same API server first",
      });
    }

    const tokenUid = sanitizeString(req.user && req.user._id);
    const gpUser = gp.userId && gp.userId.toString();

    if (
      tokenUid &&
      gpUser &&
      gpUser !== tokenUid &&
      req.user.role !== "admin"
    ) {
      return errorHandler({
        res,
        statusCode: 403,
        message: "Forbidden: cannot inspect another user's payment",
      });
    }

    if (gp.walletCredited) {
      const data = await buildSettlementPayload(gp, client_txn_id, "duplicate");
      return successHandler({
        res,
        statusCode: 200,
        message: "Payment already settled — wallet and admin recharge are up to date",
        data,
      });
    }

    const txn_date =
      validateTxnDate((req.body && req.body.txn_date) || "") ||
      validateTxnDate(gp.txn_date || "") ||
      formatTxnDate(gp.createdAt ? new Date(gp.createdAt) : new Date());

    const payload = { key: apiKey, client_txn_id, txn_date };

    let upstream;
    try {
      upstream = await ekqrPost(getCheckOrderUrl(), payload);
    } catch (err) {
      console.error("[EKQR] check_order_status upstream:", err?.message ?? err);

      /** @type {unknown} */
      let details = err && axios.isAxiosError(err) ? err.response?.data : undefined;

      await GatewayPayment.findOneAndUpdate(
        { client_txn_id },
        {
          failureReason: "check_order_upstream_error",
          rawResponse:
            err && axios.isAxiosError(err)
              ? {
                  previousRaw: gp.rawResponse ?? null,
                  error: details ?? err.message ?? null,
                }
              : { previousRaw: gp.rawResponse ?? null, error: String(err) },
        }
      ).catch(() => {});

      return errorHandler({
        res,
        statusCode: 502,
        message: "Upstream check_order_status failed",
      });
    }

    const extracted = extractCheckOrder(upstream.data);
    const checkoutOk = isCheckoutSuccessful(extracted, upstream.data);

    console.log(
      "[EKQR] check-status upstream status=",
      extracted.status,
      "checkoutOk=",
      checkoutOk,
      "txn_date=",
      txn_date
    );

    await GatewayPayment.findOneAndUpdate(
      { client_txn_id },
      {
        rawResponse: upstream.data ?? null,
        txn_date,
        ...(extracted.order_id ? { order_id: extracted.order_id } : {}),
        ...(extracted.txn_id ? { txn_id: extracted.txn_id } : {}),
      }
    ).catch(() => {});

    if (checkoutOk) {
      const gwTxn = resolveGatewayTxnId(extracted, gp, client_txn_id);

      let outcome = "failed";
      try {
        outcome = await finalizeSuccessfulGatewayPayment({
          userId: gp.userId,
          gatewayPaymentId: gp._id,
          client_txn_id,
          gatewayTxnId: gwTxn,
          webhookPayload: { check_order: upstream.data },
          sourceTag: "[check_status]",
        });
      } catch (settleErr) {
        console.error("[EKQR] settle threw:", settleErr);
        outcome = "failed";
      }

      console.log("[EKQR] check-status outcome:", outcome);

      const data = await buildSettlementPayload(gp, client_txn_id, outcome, {
        gatewayStatus: extracted.status,
        txn_date,
      });

      if (outcome !== "credited" && outcome !== "duplicate") {
        return successHandler({
          res,
          statusCode: 200,
          message:
            "Gateway reports success but wallet was not updated — check server logs (reconciliation: " +
            outcome +
            ")",
          data,
        });
      }

      return successHandler({
        res,
        statusCode: 200,
        message:
          outcome === "credited"
            ? "Payment successful — wallet updated and recharge auto-approved"
            : "Payment already settled",
        data,
      });
    }

    await markGatewayPaymentFailed({
      gatewayPaymentId: gp._id,
      webhookPayload: { check_order: upstream.data },
      reason: "check_status_gateway_not_success",
    }).catch(() => {});

    console.log("[EKQR] check-status gateway not successful:", extracted.status);

    return successHandler({
      res,
      statusCode: 200,
      message: "Payment not successful according to gateway",
      data: {
        client_txn_id,
        reconciliation: "failed",
        gatewayStatus: extracted.status,
        txn_date,
      },
    });
  } catch (e) {
    console.error("[EKQR] check-status error:", e);
    return errorHandler({
      res,
      statusCode: 500,
      message: e instanceof Error ? e.message : "Internal server error",
    });
  }
}

const checkOrderStatus = runGatewayCheckAndSettle;
const reconcilePayment = runGatewayCheckAndSettle;

/**
 * POST /api/transaction/wallet/verify/upi
 * Content-Type: application/x-www-form-urlencoded (parsed via express.urlencoded)
 */
const upiWebhook = async (req, res) => {
  console.log("Webhook Received");

  try {
    const rawBody = stringifyWebhookPayload(
      req.body && typeof req.body === "object" ? req.body : {}
    );

    console.log("[EKQR Webhook] Full payload:", JSON.stringify(rawBody));

    const secret = validateEkqrWebhookKey(req, "[EKQR Webhook]");
    if (!secret.ok) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const txn_id = sanitizeString(rawBody.txn_id);
    const client_txn_id = sanitizeString(rawBody.client_txn_id);
    const amountNum = parsePositiveAmount(rawBody.amount);
    const statusRaw =
      typeof rawBody.status !== "undefined" && rawBody.status !== null
        ? rawBody.status
        : "";

    if (!txn_id) {
      console.error("[EKQR Webhook] missing txn_id");
      return res.status(400).json({ success: false, error: "txn_id required" });
    }

    if (!client_txn_id) {
      console.error("[EKQR Webhook] missing client_txn_id");
      return res
        .status(400)
        .json({ success: false, error: "client_txn_id required" });
    }

    if (amountNum === null) {
      console.error("[EKQR Webhook] invalid amount");
      return res.status(400).json({ success: false, error: "invalid amount" });
    }

    if (!String(statusRaw).trim()) {
      console.error("[EKQR Webhook] missing status");
      return res.status(400).json({ success: false, error: "status required" });
    }

    const gp = await GatewayPayment.findOne({ client_txn_id });
    if (!gp) {
      console.error("[EKQR Webhook] unknown client_txn_id");
      return res.status(404).json({ success: false, error: "Unknown transaction" });
    }

    if (
      typeof gp.amount === "number" &&
      Math.abs(gp.amount - amountNum) > 0.015
    ) {
      console.warn(
        `[EKQR Webhook] amount mismatch webhook=${amountNum} stored=${gp.amount} — credits use stored doc`
      );
    }

    await GatewayPayment.findByIdAndUpdate(gp._id, {
      webhookPayload: rawBody,
      txn_id,
    }).catch(() => {});

    if (!isGatewaySuccess(statusRaw)) {
      await markGatewayPaymentFailed({
        gatewayPaymentId: gp._id,
        webhookPayload: rawBody,
        reason: "webhook_not_success_status",
      }).catch(() => {});

      console.log("Payment Failed");
      return res.status(200).json({ success: true });
    }

    const gwTxn =
      txn_id || resolveGatewayTxnId({ txn_id }, gp, client_txn_id);

    let outcome = "failed";
    try {
      outcome = await finalizeSuccessfulGatewayPayment({
        userId: gp.userId,
        gatewayPaymentId: gp._id,
        client_txn_id,
        gatewayTxnId: gwTxn,
        webhookPayload: rawBody,
        sourceTag: "[webhook]",
      });
    } catch (settleErr) {
      console.error("[EKQR Webhook] settle error:", settleErr);
    }

    console.log("[EKQR Webhook] outcome:", outcome);

    return res.status(200).json({ success: true, reconciliation: outcome });
  } catch (e) {
    console.error("[EKQR Webhook] unhandled:", e);
    return res.status(200).json({ success: true });
  }
};

module.exports = {
  createOrder,
  checkOrderStatus,
  reconcilePayment,
  upiWebhook,
};
