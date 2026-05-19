const { Schema, model } = require("mongoose");

/**
 * Gateway-facing wallet ledger (single balance per user).
 * User.balance (embedded) remains the source UX field; credits update both together.
 */
const gatewayWalletSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    balance: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const Wallet = model("Wallet", gatewayWalletSchema);

module.exports = Wallet;
