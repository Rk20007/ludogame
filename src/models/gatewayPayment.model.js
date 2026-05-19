const { Schema, model } = require("mongoose");

const GATEWAY_PAYMENT_STATUSES = [
  "pending",
  "success",
  "failed",
  "duplicate",
];

const gatewayPaymentSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    amount: { type: Number, required: true },

    client_txn_id: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },

    txn_id: { type: String, default: null, trim: true, sparse: true, index: true },
    order_id: { type: String, default: null, trim: true, index: true },

    status: {
      type: String,
      enum: GATEWAY_PAYMENT_STATUSES,
      default: "pending",
      index: true,
    },

    payment_url: { type: String, default: null },
    p_info: { type: String, default: "" },
    txn_date: { type: String, default: null, trim: true },

    rawResponse: { type: Schema.Types.Mixed, default: null },
    webhookPayload: { type: Schema.Types.Mixed, default: null },

    walletCredited: { type: Boolean, default: false, index: true },
    failureReason: { type: String, default: null },
  },
  { timestamps: true }
);

gatewayPaymentSchema.index({ updatedAt: -1 });

const GatewayPayment = model("GatewayPayment", gatewayPaymentSchema);

module.exports = { GatewayPayment, GATEWAY_PAYMENT_STATUSES };
