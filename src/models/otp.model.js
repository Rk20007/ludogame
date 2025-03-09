const { Schema, model } = require("mongoose");

const otpSchema = new Schema(
  {
    mobileNo: {
      type: String,
      trim: true,
      required: true,
      index: true,
    },
    requestId: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

const OTP = model("OTP", otpSchema);

module.exports = OTP;
