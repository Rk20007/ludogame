import mongoose from "mongoose";

const { Schema } = mongoose;

const PAYMENT_STATUSES = [
  "pending",
  "success",
  "failed",
  "duplicate",
];

const paymentTransactionSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    amount: { type: Number, required: true },

    /** Our unique id sent to EKQR on create_order */
    client_txn_id: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },

    /** Gateway transaction id after payment */
    txn_id: { type: String, default: null, trim: true, index: true },
    order_id: { type: String, default: null, trim: true, index: true },

    status: {
      type: String,
      enum: PAYMENT_STATUSES,
      default: "pending",
      index: true,
    },

    payment_url: { type: String, default: null },
    p_info: { type: String, default: "" },
    txn_date: { type: String, default: null, trim: true },

    /** Responses from create_order / check_order_status APIs */
    rawResponse: { type: Schema.Types.Mixed, default: null },

    /** Latest webhook body snapshot (parsed key/value object) */
    webhookPayload: { type: Schema.Types.Mixed, default: null },

    walletCredited: { type: Boolean, default: false, index: true },
    failureReason: { type: String, default: null },
  },
  { timestamps: true }
);

paymentTransactionSchema.index({ updatedAt: -1 });

const PaymentTransaction =
  mongoose.models.PaymentTransaction ||
  mongoose.model("PaymentTransaction", paymentTransactionSchema);

export default PaymentTransaction;
export { PAYMENT_STATUSES };
