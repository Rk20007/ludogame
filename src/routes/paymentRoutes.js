const express = require("express");
const { verifyToken } = require("../utils/authHelper");
const {
  createOrder,
  checkOrderStatus,
  reconcilePayment,
  upiWebhook,
} = require("../controllers/paymentController");

const router = express.Router();

router.post("/create-order", verifyToken, createOrder);
router.post("/check-status", verifyToken, checkOrderStatus);
/** Call after UPI payment success — credits wallet + auto-approves admin recharge */
router.post("/reconcile", verifyToken, reconcilePayment);

/** Must run before webhook handler — parses application/x-www-form-urlencoded only on this subtree */
const webhookRouter = express.Router();
webhookRouter.use(
  express.urlencoded({
    extended: true,
    limit: process.env.EKQR_WEBHOOK_BODY_LIMIT || "256kb",
  })
);
webhookRouter.post("/verify/upi", upiWebhook);

module.exports = router;
module.exports.webhookRouter = webhookRouter;
