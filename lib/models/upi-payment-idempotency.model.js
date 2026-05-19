import mongoose from "mongoose";

const { Schema } = mongoose;

/**
 * Guarantees at-most-once wallet credit per gateway txn_id or client_txn_id.
 */
const upiPaymentIdempotencySchema = new Schema(
  {
    txn_id: { type: String, index: true },
    client_txn_id: { type: String, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    amountCredited: { type: Number, required: true },
    paymentTransactionId: {
      type: Schema.Types.ObjectId,
      ref: "PaymentTransaction",
      required: true,
    },
  },
  { timestamps: true }
);

upiPaymentIdempotencySchema.index({ txn_id: 1 }, { unique: true, sparse: true });
upiPaymentIdempotencySchema.index({ client_txn_id: 1 }, { unique: true, sparse: true });

const UpiPaymentIdempotency =
  mongoose.models.UpiPaymentIdempotency ||
  mongoose.model("UpiPaymentIdempotency", upiPaymentIdempotencySchema);

export default UpiPaymentIdempotency;
