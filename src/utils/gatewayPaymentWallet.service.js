const mongoose = require("mongoose");
const User = require("../models/user.model");
const Transaction = require("../models/transaction.model");
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

function buildUserDetails(user) {
  const mobile =
    typeof user.mobileNo === "string" && user.mobileNo.trim()
      ? user.mobileNo.trim()
      : "0000000000";
  return {
    name: user.name || "User",
    mobileNo: mobile,
  };
}

/**
 * When user starts gateway recharge — show as pending in admin until paid or admin approves.
 */
async function createPendingGatewayRecharge({
  userId,
  amount,
  gatewayPaymentId,
  client_txn_id,
  userSnapshot,
}) {
  const exists = await Transaction.findOne({ gatewayPaymentId }).lean();
  if (exists) return exists;

  const user =
    userSnapshot ||
    (await User.findById(userId, {
      name: 1,
      mobileNo: 1,
      balance: 1,
    }).lean());

  if (!user) throw new Error("USER_NOT_FOUND");

  const [txn] = await Transaction.create([
    {
      userId,
      type: "deposit",
      amount,
      status: "pending",
      isGatewayDeposit: true,
      gatewayPaymentId,
      gatewayClientTxnId: client_txn_id || undefined,
      paymentMethod: "upi",
      userDetails: buildUserDetails(user),
      closingBalance: user.balance?.totalWalletBalance ?? 0,
    },
  ]);

  return txn;
}

/**
 * Approve pending recharge row and set UTR after settlement.
 */
async function approvePendingGatewayRecharge({
  gatewayPaymentId,
  gatewayTxnId,
  client_txn_id,
  userAfter,
  creditAmount,
  approvedBy,
  session,
}) {
  const update = {
    status: "approved",
    closingBalance: userAfter.balance?.totalWalletBalance ?? 0,
    ...(approvedBy ? { approvedBy } : {}),
    ...(gatewayTxnId ? { utrNo: gatewayTxnId } : {}),
    ...(client_txn_id ? { gatewayClientTxnId: client_txn_id } : {}),
  };

  const txn = await Transaction.findOneAndUpdate(
    { gatewayPaymentId, status: "pending" },
    update,
    { session, new: true }
  );

  if (txn) return txn;

  const existing = await Transaction.findOne({ gatewayPaymentId })
    .session(session)
    .lean();

  if (existing?.status === "approved") return existing;

  const mobile = buildUserDetails(userAfter).mobileNo;
  const [created] = await Transaction.create(
    [
      {
        userId: userAfter._id,
        type: "deposit",
        amount: creditAmount,
        status: "approved",
        isGatewayDeposit: true,
        gatewayPaymentId,
        gatewayClientTxnId: client_txn_id || undefined,
        utrNo: gatewayTxnId || undefined,
        paymentMethod: "upi",
        userDetails: {
          name: userAfter.name || "User",
          mobileNo: mobile,
        },
        closingBalance: userAfter.balance?.totalWalletBalance ?? 0,
        ...(approvedBy ? { approvedBy } : {}),
      },
    ],
    { session, ordered: true }
  );

  return created;
}

async function creditUserWallet({ userId, creditAmount, session }) {
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
  return updatedUser;
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
 * Credit wallet + approve linked pending recharge (gateway success or admin approve).
 *
 * @returns {Promise<'credited' | 'already_credited'>}
 */
async function settleGatewayRecharge({
  userId,
  gatewayPaymentId,
  gatewayTxnId,
  client_txn_id,
  webhookPayload,
  approvedBy,
  session,
}) {
  const doc = await GatewayPayment.findById(gatewayPaymentId).session(session);
  if (!doc) throw new Error("GATEWAY_PAYMENT_NOT_FOUND");

  const creditAmount = typeof doc.amount === "number" ? doc.amount : 0;
  if (!creditAmount || creditAmount <= 0) throw new Error("INVALID_AMOUNT");

  const cid = doc.client_txn_id ? String(doc.client_txn_id).trim() : "";

  if (doc.walletCredited) {
    const user = await User.findById(userId).session(session);
    if (user) {
      await approvePendingGatewayRecharge({
        gatewayPaymentId: doc._id,
        gatewayTxnId: gatewayTxnId || doc.txn_id,
        client_txn_id: cid || client_txn_id,
        userAfter: user,
        creditAmount,
        approvedBy,
        session,
      });
    }
    return "already_credited";
  }

  const updatedUser = await creditUserWallet({
    userId,
    creditAmount,
    session,
  });

  await approvePendingGatewayRecharge({
    gatewayPaymentId: doc._id,
    gatewayTxnId: gatewayTxnId || doc.txn_id,
    client_txn_id: cid || client_txn_id,
    userAfter: updatedUser,
    creditAmount,
    approvedBy,
    session,
  });

  const gpUpdate = {
    status: "success",
    walletCredited: true,
    failureReason: null,
    ...(gatewayTxnId ? { txn_id: gatewayTxnId } : {}),
  };

  if (webhookPayload !== undefined && webhookPayload !== null) {
    gpUpdate.webhookPayload = webhookPayload;
  }

  await GatewayPayment.findByIdAndUpdate(doc._id, gpUpdate, {
    session,
    runValidators: true,
  });

  return "credited";
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

  if (doc.walletCredited) {
    return "duplicate";
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
              amountCredited: doc.amount,
              gatewayPaymentId: doc._id,
            },
          ],
          { session, ordered: true }
        );
      } catch (e) {
        if (e && e.code === 11000) throw new Error("DUPLICATE_GATEWAY_PAYMENT");
        throw e;
      }

      const outcome = await settleGatewayRecharge({
        userId,
        gatewayPaymentId: doc._id,
        gatewayTxnId: txnIdForIdem,
        client_txn_id: cid,
        webhookPayload,
        session,
      });

      if (outcome === "already_credited") {
        throw new Error("DUPLICATE_GATEWAY_PAYMENT");
      }
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg === "DUPLICATE_GATEWAY_PAYMENT") {
      await GatewayPayment.findByIdAndUpdate(doc._id, {
        status: "duplicate",
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

/**
 * Admin manually approves incomplete gateway recharge (pending row).
 */
async function adminApproveGatewayRecharge({
  transactionId,
  approvedBy,
}) {
  const txn = await Transaction.findOne({
    _id: transactionId,
    status: "pending",
    type: "deposit",
    isGatewayDeposit: true,
  });

  if (!txn) return { ok: false, reason: "not_found_or_not_pending" };

  const session = await mongoose.startSession();

  try {
    let result = "credited";
    await session.withTransaction(async () => {
      const gp = await GatewayPayment.findById(txn.gatewayPaymentId).session(
        session
      );

      if (!gp) throw new Error("GATEWAY_PAYMENT_NOT_FOUND");

      if (gp.walletCredited) {
        const user = await User.findById(txn.userId).session(session);
        if (user) {
          await approvePendingGatewayRecharge({
            gatewayPaymentId: gp._id,
            gatewayTxnId: gp.txn_id,
            client_txn_id: gp.client_txn_id,
            userAfter: user,
            creditAmount: txn.amount,
            approvedBy,
            session,
          });
        }
        result = "already_credited";
        return;
      }

      await settleGatewayRecharge({
        userId: txn.userId,
        gatewayPaymentId: gp._id,
        gatewayTxnId: gp.txn_id || txn.utrNo,
        client_txn_id: gp.client_txn_id,
        approvedBy,
        session,
      });
    });

    return { ok: true, result };
  } finally {
    await session.endSession();
  }
}

module.exports = {
  validateEkqrWebhookKey,
  stringifyWebhookPayload,
  markGatewayPaymentFailed,
  finalizeSuccessfulGatewayPayment,
  createPendingGatewayRecharge,
  adminApproveGatewayRecharge,
};
