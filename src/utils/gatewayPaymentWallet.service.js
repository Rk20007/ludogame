const mongoose = require("mongoose");
const User = require("../models/user.model");
const { GatewayPayment } = require("../models/gatewayPayment.model");
const Wallet = require("../models/gatewayWallet.model");
const GatewayPaymentIdempotency = require("../models/gatewayPaymentIdempotency.model");

/**
 * @param {{ body: Record<string, unknown>; headers?: import('express').IncomingHttpHeaders }} req
 */
function validateEkqrWebhookKey(req, logTag = "[EKQR Webhook]") {
  const expected = (
    process.env.UPI_WEBHOOK_SECRET ||
    process.env.EKQR_API_KEY ||
    ""
  ).trim();
  if (!expected) return { ok: true, skipped: true };

  const h = req.headers || {};
  const headerKey =
    (typeof h["x-webhook-secret"] === "string" && h["x-webhook-secret"]) ||
    (typeof h["x-api-key"] === "string" && h["x-api-key"]) ||
    (typeof h["api-key"] === "string" && h["api-key"]) ||
    "";

  const auth = typeof h.authorization === "string" ? h.authorization : "";
  const bearer =
    auth && auth.toLowerCase().startsWith("bearer ")
      ? auth.slice(7).trim()
      : "";

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const fromBody =
    (typeof body.api_key === "string" && body.api_key.trim()) ||
    (typeof body.key === "string" && body.key.trim()) ||
    "";

  const provided = headerKey.trim() || bearer || fromBody;
  if (!provided || provided !== expected) {
    console.error(`${logTag} Unauthorized gateway key mismatch or missing`);
    return { ok: false, skipped: false };
  }
  return { ok: true, skipped: false };
}

/**
 * Persist full webhook form body (dynamic keys).
 */
function stringifyWebhookPayload(body) {
  if (!body || typeof body !== "object") return {};
  /** @type {Record<string, string>} */
  const out = {};
  Object.keys(body).forEach((k) => {
    const v = body[k];
    if (v === undefined || v === null) out[k] = "";
    else if (typeof v === "string") out[k] = v;
    else out[k] = String(v);
  });
  return out;
}

async function markGatewayPaymentFailed({
  gatewayPaymentId,
  client_txn_id,
  webhookPayload,
  reason,
}) {
  const filter =
    gatewayPaymentId != null
      ? { _id: gatewayPaymentId }
      : client_txn_id
        ? { client_txn_id: String(client_txn_id).trim() }
        : null;

  if (!filter) return null;

  const update = {
    status: "failed",
    walletCredited: false,
    failureReason: reason,
  };
  if (webhookPayload !== undefined && webhookPayload !== null) {
    update.webhookPayload = webhookPayload;
  }

  return GatewayPayment.findOneAndUpdate(filter, update, {
    new: true,
    runValidators: true,
  });
}

/**
 * @returns {Promise<'credited' | 'duplicate' | 'missing_user_id' | 'missing_row' | 'missing_txn_id'>}
 */
async function finalizeSuccessfulGatewayPayment({
  userId,
  gatewayPaymentId,
  client_txn_id,
  gatewayTxnId,
  webhookPayload,
  sourceTag,
}) {
  if (!userId) return "missing_user_id";

  let doc = null;
  if (gatewayPaymentId) {
    doc = await GatewayPayment.findById(gatewayPaymentId);
  }
  if (!doc && client_txn_id) {
    doc = await GatewayPayment.findOne({
      client_txn_id: String(client_txn_id).trim(),
    });
  }

  if (!doc) {
    console.error(`${sourceTag} GatewayPayment row not found`);
    return "missing_row";
  }

  const txnIdForIdem =
    gatewayTxnId && String(gatewayTxnId).trim()
      ? String(gatewayTxnId).trim()
      : "";

  if (!txnIdForIdem) {
    await GatewayPayment.findByIdAndUpdate(doc._id, {
      failureReason: "missing_txn_id_for_idempotency",
    }).catch(() => {});
    console.error(`${sourceTag} Missing gateway txn_id`);
    return "missing_txn_id";
  }

  const creditAmount = typeof doc.amount === "number" ? doc.amount : 0;
  if (!creditAmount || creditAmount <= 0) {
    await GatewayPayment.findByIdAndUpdate(doc._id, {
      failureReason: "invalid_stored_amount",
    }).catch(() => {});
    return "missing_row";
  }

  const cid = doc.client_txn_id ? String(doc.client_txn_id).trim() : "";

  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      try {
        await GatewayPaymentIdempotency.create(
          [
            {
              txn_id: txnIdForIdem,
              client_txn_id: cid || undefined,
              userId,
              amountCredited: creditAmount,
              gatewayPaymentId: doc._id,
            },
          ],
          { session, ordered: true }
        );
      } catch (e) {
        if (e && e.code === 11000) throw new Error("DUPLICATE_GATEWAY_PAYMENT");
        throw e;
      }

      await Wallet.findOneAndUpdate(
        { userId },
        { $inc: { balance: creditAmount } },
        { upsert: true, session, new: true, setDefaultsOnInsert: true }
      );

      const updatedUser = await User.findByIdAndUpdate(
        userId,
        {
          $inc: {
            "balance.totalBalance": creditAmount,
            "balance.totalWalletBalance": creditAmount,
          },
        },
        { session, new: true }
      );

      if (!updatedUser) throw new Error("USER_NOT_FOUND");

      const gpUpdate = {
        status: "success",
        walletCredited: true,
        txn_id: txnIdForIdem,
        failureReason: null,
      };

      if (webhookPayload !== undefined && webhookPayload !== null) {
        gpUpdate.webhookPayload = webhookPayload;
      }

      await GatewayPayment.findByIdAndUpdate(doc._id, gpUpdate, {
        session,
        runValidators: true,
      });
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg === "DUPLICATE_GATEWAY_PAYMENT") {
      await GatewayPayment.findByIdAndUpdate(doc._id, {
        status: "duplicate",
        walletCredited: false,
        failureReason: `duplicate_txn_${String(sourceTag).replace(/\W/g, "_")}`,
        ...(webhookPayload !== undefined && webhookPayload !== null
          ? { webhookPayload }
          : {}),
      }).catch(() => {});
      return "duplicate";
    }

    if (msg === "USER_NOT_FOUND") {
      await GatewayPayment.findByIdAndUpdate(doc._id, {
        status: "failed",
        walletCredited: false,
        failureReason: "user_not_found_on_finalize",
      }).catch(() => {});
      return "missing_user_id";
    }

    await GatewayPayment.findByIdAndUpdate(doc._id, {
      status: "failed",
      walletCredited: false,
      failureReason: "finalize_transaction_error",
    }).catch(() => {});

    throw error;
  } finally {
    await session.endSession();
  }

  return "credited";
}

module.exports = {
  validateEkqrWebhookKey,
  stringifyWebhookPayload,
  markGatewayPaymentFailed,
  finalizeSuccessfulGatewayPayment,
};
