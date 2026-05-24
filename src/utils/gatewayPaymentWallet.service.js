const mongoose = require("mongoose");
const User = require("../models/user.model");
const Transaction = require("../models/transaction.model");
const { GatewayPayment } = require("../models/gatewayPayment.model");
const Wallet = require("../models/gatewayWallet.model");
const GatewayPaymentIdempotency = require("../models/gatewayPaymentIdempotency.model");

function sessionOpts(session) {
  return session ? { session } : {};
}

function isMongoTransactionUnsupported(error) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    error?.code === 20 ||
    /replica set/i.test(msg) ||
    /Transaction numbers/i.test(msg) ||
    /multi-document transactions/i.test(msg)
  );
}

/**
 * @template T
 * @param {(session: import('mongoose').ClientSession | null) => Promise<T>} fn
 */
async function withOptionalTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } catch (error) {
    if (isMongoTransactionUnsupported(error)) {
      console.warn(
        "[Gateway] MongoDB transactions unavailable — running without session"
      );
      return fn(null);
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

/** Append client_txn_id so external frontend can call check-status after redirect. */
function appendClientTxnToRedirectUrl(baseUrl, client_txn_id) {
  const base = String(baseUrl || "").trim();
  if (!base || !client_txn_id) return base;
  try {
    const url = new URL(base);
    url.searchParams.set("client_txn_id", client_txn_id);
    return url.toString();
  } catch {
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}client_txn_id=${encodeURIComponent(client_txn_id)}`;
  }
}

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
      gatewayAwaitingPayment: true,
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
  const isGatewayAuto = !approvedBy;

  const update = {
    status: "approved",
    gatewayAwaitingPayment: false,
    closingBalance: userAfter.balance?.totalWalletBalance ?? 0,
    ...(isGatewayAuto
      ? {
          isAutoApproved: true,
          approvalSource: "gateway",
          gatewaySettledAt: new Date(),
        }
      : {
          isAutoApproved: false,
          approvalSource: "admin",
        }),
    ...(approvedBy ? { approvedBy } : {}),
    ...(gatewayTxnId ? { utrNo: gatewayTxnId } : {}),
    ...(client_txn_id ? { gatewayClientTxnId: client_txn_id } : {}),
  };

  const txn = await Transaction.findOneAndUpdate(
    { gatewayPaymentId, status: "pending" },
    update,
    { ...sessionOpts(session), new: true }
  );

  if (txn) return txn;

  let existingQuery = Transaction.findOne({ gatewayPaymentId });
  if (session) existingQuery = existingQuery.session(session);
  const existing = await existingQuery.lean();

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
        gatewayAwaitingPayment: false,
        gatewayPaymentId,
        gatewayClientTxnId: client_txn_id || undefined,
        utrNo: gatewayTxnId || undefined,
        paymentMethod: "upi",
        userDetails: {
          name: userAfter.name || "User",
          mobileNo: mobile,
        },
        closingBalance: userAfter.balance?.totalWalletBalance ?? 0,
        ...(isGatewayAuto
          ? {
              isAutoApproved: true,
              approvalSource: "gateway",
              gatewaySettledAt: new Date(),
            }
          : {
              isAutoApproved: false,
              approvalSource: "admin",
            }),
        ...(approvedBy ? { approvedBy } : {}),
      },
    ],
    { ...sessionOpts(session), ordered: true }
  );

  return created;
}

async function creditUserWallet({ userId, creditAmount, session }) {
  await Wallet.findOneAndUpdate(
    { userId },
    { $inc: { balance: creditAmount } },
    {
      upsert: true,
      ...sessionOpts(session),
      new: true,
      setDefaultsOnInsert: true,
    }
  );

  const updatedUser = await User.findByIdAndUpdate(
    userId,
    {
      $inc: {
        "balance.totalBalance": creditAmount,
        "balance.totalWalletBalance": creditAmount,
      },
    },
    { ...sessionOpts(session), new: true }
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

  const gp = await GatewayPayment.findOneAndUpdate(filter, update, {
    new: true,
    runValidators: true,
  });

  if (gp?._id) {
    await Transaction.findOneAndUpdate(
      { gatewayPaymentId: gp._id, gatewayAwaitingPayment: true },
      { gatewayAwaitingPayment: false }
    ).catch(() => {});
  }

  return gp;
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
  let gpQuery = GatewayPayment.findById(gatewayPaymentId);
  if (session) gpQuery = gpQuery.session(session);
  const doc = await gpQuery;
  if (!doc) throw new Error("GATEWAY_PAYMENT_NOT_FOUND");

  const creditAmount = typeof doc.amount === "number" ? doc.amount : 0;
  if (!creditAmount || creditAmount <= 0) throw new Error("INVALID_AMOUNT");

  const cid = doc.client_txn_id ? String(doc.client_txn_id).trim() : "";
  const payUserId = doc.userId || userId;

  if (doc.walletCredited) {
    let userQuery = User.findById(payUserId);
    if (session) userQuery = userQuery.session(session);
    const user = await userQuery;
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
    userId: payUserId,
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
    ...sessionOpts(session),
    runValidators: true,
  });

  return "credited";
}

/**
 * Gateway success → credit user wallet + auto-approve admin Transaction.
 * @returns {Promise<'credited' | 'duplicate' | 'missing_user_id' | 'missing_row' | 'missing_txn_id'>}
 */
async function reconcileSuccessfulGatewayPayment({
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
    console.error(`${sourceTag} GatewayPayment not found`);
    return "missing_row";
  }

  const cid = doc.client_txn_id ? String(doc.client_txn_id).trim() : "";

  const txnIdForIdem =
    (gatewayTxnId && String(gatewayTxnId).trim()) ||
    (cid ? `client_${cid}` : "");

  if (!txnIdForIdem) {
    await GatewayPayment.findByIdAndUpdate(doc._id, {
      failureReason: "missing_txn_id_for_idempotency",
    }).catch(() => {});
    return "missing_txn_id";
  }

  const effectiveUserId = doc.userId || userId;

  if (doc.walletCredited) {
    const user = await User.findById(effectiveUserId);
    if (user) {
      await approvePendingGatewayRecharge({
        gatewayPaymentId: doc._id,
        gatewayTxnId: txnIdForIdem,
        client_txn_id: cid,
        userAfter: user,
        creditAmount: doc.amount,
        approvedBy: null,
        session: null,
      }).catch(() => {});
    }
    return "duplicate";
  }

  try {
    await withOptionalTransaction(async (session) => {
      try {
        await GatewayPaymentIdempotency.create(
          [
            {
              txn_id: txnIdForIdem,
              client_txn_id: cid || undefined,
              userId: effectiveUserId,
              amountCredited: doc.amount,
              gatewayPaymentId: doc._id,
            },
          ],
          { ...sessionOpts(session), ordered: true }
        );
      } catch (e) {
        if (e && e.code === 11000) throw new Error("DUPLICATE_GATEWAY_PAYMENT");
        throw e;
      }

      const outcome = await settleGatewayRecharge({
        userId: effectiveUserId,
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
      return "duplicate";
    }
    if (msg === "USER_NOT_FOUND") {
      await GatewayPayment.findByIdAndUpdate(doc._id, {
        failureReason: "user_not_found_on_finalize",
      }).catch(() => {});
      return "missing_user_id";
    }
    console.error(`${sourceTag} reconcile failed:`, error);
    await GatewayPayment.findByIdAndUpdate(doc._id, {
      failureReason: "finalize_transaction_error",
    }).catch(() => {});
    throw error;
  }

  console.log(
    `${sourceTag} OK — user wallet credited, admin transaction auto-approved`
  );
  return "credited";
}

/**
 * @returns {Promise<'credited' | 'duplicate' | 'missing_user_id' | 'missing_row' | 'missing_txn_id'>}
 */
async function finalizeSuccessfulGatewayPayment(params) {
  return reconcileSuccessfulGatewayPayment(params);
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

  try {
    let result = "credited";
    await withOptionalTransaction(async (session) => {
      let gpQuery = GatewayPayment.findById(txn.gatewayPaymentId);
      if (session) gpQuery = gpQuery.session(session);
      const gp = await gpQuery;

      if (!gp) throw new Error("GATEWAY_PAYMENT_NOT_FOUND");

      if (gp.walletCredited) {
        let userQuery = User.findById(txn.userId);
        if (session) userQuery = userQuery.session(session);
        const user = await userQuery;
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
  } catch (error) {
    console.error("[Gateway] adminApproveGatewayRecharge:", error);
    return { ok: false, reason: "settlement_failed" };
  }
}

module.exports = {
  validateEkqrWebhookKey,
  stringifyWebhookPayload,
  markGatewayPaymentFailed,
  finalizeSuccessfulGatewayPayment,
  reconcileSuccessfulGatewayPayment,
  createPendingGatewayRecharge,
  adminApproveGatewayRecharge,
  appendClientTxnToRedirectUrl,
};
