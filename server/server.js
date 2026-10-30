const express = require("express");
const cors = require("cors");
const { PrismaClient } = require("@prisma/client");
require("dotenv").config();

const { getAccessToken, initiateSTKPush, querySTKPushStatus } = require("./mpesa");
const { getMpesaErrorMessage } = require("./error-handler");

const prisma = new PrismaClient();
const app = express();
app.use(cors());
app.use(express.json());

// Helper function
function getCallbackValue(metadata, name) {
  if (!metadata || !Array.isArray(metadata.Item)) {
    return null;
  }
  const item = metadata.Item.find((entry) => entry.Name === name);
  return item ? item.Value : null;
}

function paymentUserMessage(resultCode, fallback) {
  if (resultCode === null || resultCode === undefined) {
    return fallback || "Payment failed. Please try again.";
  }
  return getMpesaErrorMessage(resultCode);
}

// Mark stale pending payments as timed out
async function cleanupStalePayments() {
  const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);

  const stalePayments = await prisma.payment.updateMany({
    where: {
      status: "pending",
      createdAt: { lt: twoMinutesAgo },
    },
    data: {
      status: "failed",
      resultCode: 1019,
      resultDesc: getMpesaErrorMessage(1019),
    },
  });

  if (stalePayments.count > 0) {
    console.log(`Cleaned up ${stalePayments.count} stale payments.`);
  }
}

setInterval(cleanupStalePayments, 5 * 60 * 1000);

// Health Check
app.get("/api/health", (req, res) => {
  const hasKey = !!process.env.MPESA_CONSUMER_KEY;
  const hasSecret = !!process.env.MPESA_CONSUMER_SECRET;

  res.json({
    status: "ok",
    mpesa_configured: hasKey && hasSecret,
    environment: process.env.MPESA_ENV || "not set",
  });
});

// Test OAuth endpoint
app.get("/api/mpesa/token", async (req, res) => {
  try {
    const startTime = Date.now();
    const token = await getAccessToken();
    const duration = Date.now() - startTime;

    res.json({
      success: true,
      token_preview: token.substring(0, 20) + "...",
      fetch_time_ms: duration,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Query payment status from Daraja
app.get("/api/mpesa/status/:checkoutRequestId", async (req, res) => {
  try {
    const { checkoutRequestId } = req.params;

    // First check our database
    const payment = await prisma.payment.findUnique({
      where: { checkoutRequestId },
    });

    if (!payment) {
      return res.status(404).json({
        success: false,
        error: "Payment not found",
      });
    }

    // If payment is already completed or failed, return the stored result
    if (
      payment.status === "completed" ||
      payment.status === "failed" ||
      payment.status === "cancelled"
    ) {
      return res.json({
        success: true,
        data: {
          status: payment.status,
          resultCode: payment.resultCode,
          resultDesc: paymentUserMessage(payment.resultCode, payment.resultDesc),
          mpesaReceiptNumber: payment.mpesaReceiptNumber,
          transactionDate: payment.transactionDate,
          amount: payment.amount,
          phoneNumber: payment.phoneNumber,
        },
      });
    }

    // If still pending, query Daraja for the latest status
    try {
      const queryResult = await querySTKPushStatus(checkoutRequestId);
      const resultCode = parseInt(queryResult.ResultCode, 10);
      const userMessage = paymentUserMessage(resultCode, queryResult.ResultDesc);

      if (resultCode === 0) {
        // Mark completed from query. Receipt/date come only from the callback.
        await prisma.payment.update({
          where: { checkoutRequestId },
          data: {
            status: "completed",
            resultCode,
            resultDesc: userMessage,
          },
        });

        return res.json({
          success: true,
          data: {
            status: "completed",
            resultCode,
            resultDesc: userMessage,
            mpesaReceiptNumber: payment.mpesaReceiptNumber,
            transactionDate: payment.transactionDate,
            amount: payment.amount,
            phoneNumber: payment.phoneNumber,
          },
        });
      } else if (resultCode === 1032) {
        await prisma.payment.update({
          where: { checkoutRequestId },
          data: {
            status: "cancelled",
            resultCode,
            resultDesc: userMessage,
          },
        });

        return res.json({
          success: true,
          data: {
            status: "cancelled",
            resultCode,
            resultDesc: userMessage,
          },
        });
      } else if (resultCode === 1) {
        // Still waiting for the user to enter PIN
        return res.json({
          success: true,
          data: {
            status: "pending",
            resultCode,
            resultDesc: userMessage,
            message: "Payment is still being processed. Try again in a few seconds.",
          },
        });
      } else {
        await prisma.payment.update({
          where: { checkoutRequestId },
          data: {
            status: "failed",
            resultCode,
            resultDesc: userMessage,
          },
        });

        return res.json({
          success: true,
          data: {
            status: "failed",
            resultCode,
            resultDesc: userMessage,
          },
        });
      }
    } catch (queryError) {
      // Query failed -- the payment might still be processing
      return res.json({
        success: true,
        data: {
          status: "pending",
          message: "Payment is still being processed. Try again in a few seconds.",
        },
      });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Poll payment status by payment ID
app.get("/api/payments/:id/poll", async (req, res) => {
  try {
    const payment = await prisma.payment.findUnique({
      where: { id: req.params.id },
    });

    if (!payment) {
      return res.status(404).json({ success: false, error: "Payment not found" });
    }

    // If already resolved, return immediately
    if (payment.status !== "pending") {
      return res.json({
        success: true,
        data: {
          status: payment.status,
          mpesaReceiptNumber: payment.mpesaReceiptNumber,
          transactionDate: payment.transactionDate,
          resultCode: payment.resultCode,
          resultDesc: paymentUserMessage(payment.resultCode, payment.resultDesc),
          amount: payment.amount,
        },
      });
    }

    // Still pending -- try querying Daraja
    try {
      const queryResult = await querySTKPushStatus(payment.checkoutRequestId);
      const resultCode = parseInt(queryResult.ResultCode, 10);
      const userMessage = paymentUserMessage(resultCode, queryResult.ResultDesc);

      let status = "pending";
      if (resultCode === 0) status = "completed";
      else if (resultCode === 1032) status = "cancelled";
      else if (resultCode !== 1) status = "failed";

      if (status !== "pending") {
        await prisma.payment.update({
          where: { id: payment.id },
          data: {
            status,
            resultCode,
            resultDesc: userMessage,
          },
        });
      }

      return res.json({
        success: true,
        data: {
          status,
          resultCode,
          resultDesc: userMessage,
          mpesaReceiptNumber: payment.mpesaReceiptNumber,
          transactionDate: payment.transactionDate,
          amount: payment.amount,
        },
      });
    } catch (queryError) {
      // Query failed, still pending
      return res.json({
        success: true,
        data: { status: "pending" },
      });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get Payment status
app.get("/api/payments/:id", async (req, res) => {
  try {
    const payment = await prisma.payment.findUnique({
      where: { id: req.params.id },
    });

    if (!payment) {
      return res.status(404).json({ success: false, error: "Payment not found" });
    }

    res.json({
      success: true,
      data: {
        ...payment,
        resultDesc: paymentUserMessage(payment.resultCode, payment.resultDesc),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// List all payments
app.get("/api/payments", async (req, res) => {
  try {
    const payments = await prisma.payment.findMany({
      orderBy: { createdAt: "desc" } ,
    });

    res.json({ success: true, data: payments });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
});

// Initiate STK Push
app.post("/api/mpesa/stkpush", async (req, res) => {
  try {
    const { phoneNumber, amount, accountReference, transactionDesc } = req.body;

    // Validate required fields
    if (!phoneNumber) {
      return res.status(400).json({
        success: false,
        error: "Phone number is required",
      });
    }

    if (!amount || amount < 1) {
      return res.status(400).json({
        success: false,
        error: "Amount must be at least 1 KES",
      });
    }

    // Format phone number: convert 07XX to 2547XX format
    let formattedPhone = String(phoneNumber).trim();
    if (formattedPhone.startsWith("0")) {
      formattedPhone = "254" + formattedPhone.substring(1);
    }
    if (formattedPhone.startsWith("+")) {
      formattedPhone = formattedPhone.substring(1);
    }

    // Validate phone number format
    if (!/^254[17]\d{8}$/.test(formattedPhone)) {
      return res.status(400).json({
        success: false,
        error:
          "Invalid phone number. Use format 254XXXXXXXXX (e.g., 254712345678)",
      });
    }

    console.log(`Initiating STK Push: ${formattedPhone},  KES ${amount}`);

    // Send STK Push
    const result = await initiateSTKPush(
      formattedPhone,
      amount,
      accountReference || "Paylink",
      transactionDesc || "Payment",
    );

    // Store the pending payment in the database
    const payment = await prisma.payment.create({
      data: {
        checkoutRequestId: result.CheckoutRequestID,
        merchantRequestId: result.MerchantRequestID,
        phoneNumber: formattedPhone,
        amount: parseFloat(amount),
        accountReference: accountReference || "PayLink",
        transactionDesc: transactionDesc || "Payment",
        status: "pending",
      },
    });

    res.json({
      success: true,
      message: "STK Push sent. Check your phone for the M-Pesa prompt.",
      data: {
        paymentId: payment.id,
        checkoutRequestId: result.CheckoutRequestID,
      },
    });
  } catch (error) {
    console.error("STK Push endpoint error:", error.message);
    res.status(500).json({
      success: false,
      error:
        "Could not start the M-Pesa payment. Please check your phone number and try again.",
      details: error.message,
    });
  }
});

// M-Pesa callback endpoint
app.post("/api/mpesa/callback", async (req, res) => {
  // Always respond with a 200 status immediately
  res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });

  try {
    const { stkCallback } = req.body.Body;
    const {
      CheckoutRequestID,
      ResultCode,
      ResultDesc,
      CallbackMetadata,
    } = stkCallback;

    console.log(
      `Callback received for ${CheckoutRequestID}: ResultCode=${ResultCode}`,
    );

    const existingPayment = await prisma.payment.findUnique({
      where: { checkoutRequestId: CheckoutRequestID },
    });

    if (!existingPayment) {
      console.warn(
        `Callback for unknown CheckoutRequestID: ${CheckoutRequestID}`,
      );
      return;
    }

    // Allow callback to backfill receipt/date even if poll already marked completed
    const needsReceiptBackfill =
      existingPayment.status === "completed" &&
      !existingPayment.mpesaReceiptNumber &&
      ResultCode === 0;

    if (existingPayment.status !== "pending" && !needsReceiptBackfill) {
      console.log(
        `Duplicate callback for ${CheckoutRequestID}. Already ${existingPayment.status}. Skipping`,
      );
      return;
    }

    const userMessage = paymentUserMessage(ResultCode, ResultDesc);

    if (ResultCode === 0) {
      const receipt = getCallbackValue(CallbackMetadata, "MpesaReceiptNumber");
      const transactionDate = getCallbackValue(
        CallbackMetadata,
        "TransactionDate",
      );

      await prisma.payment.update({
        where: { checkoutRequestId: CheckoutRequestID },
        data: {
          status: "completed",
          resultCode: ResultCode,
          resultDesc: userMessage,
          mpesaReceiptNumber: receipt != null ? String(receipt) : null,
          transactionDate:
            transactionDate != null ? String(transactionDate) : null,
        },
      });

      console.log(`Payment ${CheckoutRequestID} completed. Receipt: ${receipt}`);
    } else {
      const status = ResultCode === 1032 ? "cancelled" : "failed";

      await prisma.payment.update({
        where: { checkoutRequestId: CheckoutRequestID },
        data: {
          status,
          resultCode: ResultCode,
          resultDesc: userMessage,
        },
      });

      console.log(`Payment ${CheckoutRequestID} ${status}: ${userMessage}`);
    }
  } catch (error) {
    console.error("Error processing callback:", error.message);
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
