const mongoose = require("mongoose");

const { Schema } = mongoose;

const gatewayPaymentIdempotencySchema = new Schema(
  {
    txn_id: { type: String, index: true },
    client_txn_id: { type: String, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    amountCredited: { type: Number, required: true },
    gatewayPaymentId: {
      type: Schema.Types.ObjectId,
      ref: "GatewayPayment",
      required: true,
    },
  },
  { timestamps: true }
);

gatewayPaymentIdempotencySchema.index({ txn_id: 1 }, { unique: true, sparse: true });
gatewayPaymentIdempotencySchema.index({ client_txn_id: 1 }, { unique: true, sparse: true });

const GatewayPaymentIdempotency =
  mongoose.models.GatewayPaymentIdempotency ||
  mongoose.model("GatewayPaymentIdempotency", gatewayPaymentIdempotencySchema);

module.exports = GatewayPaymentIdempotency;
