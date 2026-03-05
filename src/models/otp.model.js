const { Schema, model } = require("mongoose");

const otpSchema = new Schema(
  {
    mobileNo: {
      type: String,
      trim: true,
      required: true,
      index: true,
    },
    otp: {
      type: String,
      default: null,
    },
    requestId: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

const OTP = model("OTP", otpSchema);

module.exports = OTP;
