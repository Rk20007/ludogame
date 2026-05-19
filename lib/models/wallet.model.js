import mongoose from "mongoose";

const { Schema } = mongoose;

/**
 * Standalone wallet document (userId ↔ balance mirror for gateway flows).
 * User profile still holds `balance.*`; gateway credits update both to stay aligned.
 */
const walletSchema = new Schema(
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

const Wallet =
  mongoose.models.Wallet || mongoose.model("Wallet", walletSchema);

export default Wallet;
