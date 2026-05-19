const axios = require("axios");

// Renflair SMS Configuration
const SMS_API_URL = process.env.SMS_API_URL || "https://sms.renflair.in/V1.php";
const SMS_API_KEY = process.env.SMS_API_KEY || "05b0afd266cc205432b8dad3f3413c28";

/**
 * Send OTP via SMS using Renflair service
 * @param {string} phoneNumber - Mobile number to send OTP to
 * @param {string} otp - OTP code to send
 * @returns {Promise<boolean>} - Returns true if SMS sent successfully
 */
const sendOTPViaSMS = async (phoneNumber, otp) => {
  try {
    // Validate inputs
    if (!phoneNumber || !otp) {
      console.error("Invalid phone number or OTP");
      return false;
    }

    // Build the request URL with parameters
    const url = `${SMS_API_URL}?API=${SMS_API_KEY}&PHONE=${phoneNumber}&OTP=${otp}`;

    // Make the request
    const response = await axios.get(url, {
      timeout: 10000, // 10 second timeout
      headers: {
        "User-Agent": "LudoGame-OTP-Service/1.0",
      },
    });

    // Log the response for debugging
    console.log(`SMS sent to ${phoneNumber}:`, response.data);

    // Check if response indicates success
    // Adjust based on actual Renflair API response format
    if (response.status === 200 && response.data) {
      return true;
    }

    return false;
  } catch (error) {
    console.error(`Failed to send SMS to ${phoneNumber}:`, error.message);
    // Log full error for debugging in development
    if (process.env.NODE_ENV !== "production") {
      console.error("Full error:", error);
    }
    return false;
  }
};

/**
 * Send OTP with message template
 * @param {string} phoneNumber - Mobile number
 * @param {string} otp - OTP code
 * @returns {Promise<boolean>}
 */
const sendOTPMessage = async (phoneNumber, otp) => {
  return sendOTPViaSMS(phoneNumber, otp);
};

module.exports = {
  sendOTPViaSMS,
  sendOTPMessage,
};
