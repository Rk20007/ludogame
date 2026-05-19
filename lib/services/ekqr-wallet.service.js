import mongoose from "mongoose";
import { createRequire } from "module";
import PaymentTransaction from "../models/payment-transaction.model.js";
import Wallet from "../models/wallet.model.js";
import UpiPaymentIdempotency from "../models/upi-payment-idempotency.model.js";
import { normalizeStatus } from "../utils/payment-parse.js";

const require = createRequire(import.meta.url);

function loadUserModel() {
  return require("../../src/models/user.model.js");
}


/**
 * Idempotent success path: Wallet doc + User.balance + PaymentTransaction + idempotency row.
 * Credits use **`payment` document `amount`** (not the webhook/callback payload) to avoid tampering.
 *
 * @returns {Promise<'credited' | 'duplicate' | 'missing_user' | 'missing_user_id' | 'missing_payment_row'>}
 */
export async function finalizeSuccessfulEkqrPayment({
  userId,
  /** @type {import('mongoose').Types.ObjectId|null|undefined} */
  paymentTransactionId,
  gatewayTxnId,
  client_txn_id,
  webhookPayload,
  source,
}) {
  const User = loadUserModel();

  if (!userId) {
    return "missing_user_id";
  }

  let paymentDoc = null;
  if (paymentTransactionId) {
    paymentDoc = await PaymentTransaction.findById(paymentTransactionId);
  } else if (client_txn_id) {
    paymentDoc = await PaymentTransaction.findOne({ client_txn_id });
  }

  if (!paymentDoc) {
    console.error(
      `[EKQR ${source}] finalize: PaymentTransaction not found for client_txn_id=${client_txn_id || "n/a"}`
    );
    return "missing_payment_row";
  }

  const txnIdForIdem = gatewayTxnId?.trim() || "";

  if (!txnIdForIdem) {
    await PaymentTransaction.findByIdAndUpdate(paymentDoc._id, {
      failureReason: "missing_txn_id_for_idempotency",
    }).catch(() => {});
    console.error(`[EKQR ${source}] finalize: missing gateway txn_id`);
    return "missing_user";
  }

  const creditAmount =
    typeof paymentDoc.amount === "number" ? paymentDoc.amount : 0;

  if (!creditAmount || creditAmount <= 0) {
    await PaymentTransaction.findByIdAndUpdate(paymentDoc._id, {
      failureReason: "invalid_stored_amount",
    }).catch(() => {});
    console.error("[EKQR] finalize: invalid stored amount");
    return "missing_payment_row";
  }

  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      try {
        await UpiPaymentIdempotency.create(
          [
            {
              txn_id: txnIdForIdem || undefined,
              client_txn_id: client_txn_id || undefined,
              userId,
              amountCredited: creditAmount,
              paymentTransactionId: paymentDoc._id,
            },
          ],
          { session, ordered: true }
        );
      } catch (err) {
        if (err && err.code === 11000) {
          throw new Error("DUPLICATE_TXN");
        }
        throw err;
      }

      await Wallet.findOneAndUpdate(
        { userId },
        { $inc: { balance: creditAmount } },
        { upsert: true, session, new: true, setDefaultsOnInsert: true }
      );

      const userAfter = await User.findByIdAndUpdate(
        userId,
        {
          $inc: {
            "balance.totalBalance": creditAmount,
            "balance.totalWalletBalance": creditAmount,
          },
        },
        { session, new: true }
      );

      if (!userAfter) {
        throw new Error("USER_NOT_FOUND");
      }

      await PaymentTransaction.findByIdAndUpdate(
        paymentDoc._id,
        {
          status: "success",
          walletCredited: true,
          txn_id: txnIdForIdem,
          failureReason: null,
          ...(webhookPayload !== undefined ? { webhookPayload } : {}),
        },
        { session }
      );
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message === "DUPLICATE_TXN") {
      await PaymentTransaction.findByIdAndUpdate(paymentDoc._id, {
        status: "duplicate",
        walletCredited: false,
        failureReason: `duplicate_txn_${source}`,
        ...(webhookPayload !== undefined ? { webhookPayload } : {}),
      }).catch(() => {});
      return "duplicate";
    }

    if (message === "USER_NOT_FOUND") {
      await PaymentTransaction.findByIdAndUpdate(paymentDoc._id, {
        status: "failed",
        walletCredited: false,
        failureReason: "user_not_found_on_finalize",
      }).catch(() => {});
      return "missing_user";
    }

    await PaymentTransaction.findByIdAndUpdate(paymentDoc._id, {
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
 * Mark payment failed (no wallet change).
 */
export async function markPaymentFailed({
  paymentTransactionId,
  client_txn_id,
  webhookPayload,
  reason,
}) {
  const filter = paymentTransactionId
    ? { _id: paymentTransactionId }
    : client_txn_id
      ? { client_txn_id }
      : null;
  if (!filter) return null;
  return PaymentTransaction.findOneAndUpdate(
    filter,
    {
      status: "failed",
      walletCredited: false,
      failureReason: reason,
      ...(webhookPayload !== undefined ? { webhookPayload } : {}),
    },
    { new: true }
  );
}

/**
 * Normalize EKQR / check_order / webhook free-form success flag.
 */
export function isGatewaySuccessStatus(raw) {
  return normalizeStatus(raw) === "success";
}
