"use client";

import { useState } from "react";

const styles = {
  page: {
    minHeight: "100vh",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    background: "radial-gradient(circle at top, rgba(10, 57, 111, 0.95), rgba(2, 14, 38, 1))",
    padding: "2rem",
    color: "#fff",
    fontFamily: "Inter, system-ui, sans-serif",
  },
  card: {
    width: "100%",
    maxWidth: "540px",
    background: "rgba(255,255,255,0.08)",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: "24px",
    boxShadow: "0 30px 80px rgba(0,0,0,0.35)",
    padding: "2rem",
    backdropFilter: "blur(18px)",
  },
  header: {
    marginBottom: "1.5rem",
  },
  title: {
    fontSize: "2rem",
    margin: "0 0 0.5rem",
  },
  subtitle: {
    margin: 0,
    color: "#d0d7ff",
  },
  formGroup: {
    display: "grid",
    gap: "1rem",
    marginTop: "1.5rem",
  },
  label: {
    display: "flex",
    flexDirection: "column",
    fontSize: "0.95rem",
    gap: "0.5rem",
    color: "#e5ecff",
  },
  input: {
    width: "100%",
    padding: "0.95rem 1rem",
    borderRadius: "14px",
    border: "1px solid rgba(255,255,255,0.18)",
    background: "rgba(255,255,255,0.06)",
    color: "#fff",
    outline: "none",
    fontSize: "0.95rem",
  },
  button: {
    width: "100%",
    padding: "1rem 1.25rem",
    borderRadius: "14px",
    border: "none",
    background: "#4f7cff",
    color: "#fff",
    fontSize: "1rem",
    fontWeight: 600,
    cursor: "pointer",
    transition: "transform 0.2s ease, background 0.2s ease",
  },
  buttonSecondary: {
    background: "transparent",
    border: "1px solid rgba(255,255,255,0.25)",
    color: "#fff",
  },
  infoBox: {
    marginTop: "1.5rem",
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.12)",
    padding: "1rem 1.25rem",
    borderRadius: "16px",
    color: "#e4e9ff",
  },
  success: {
    color: "#6ee7b7",
  },
  error: {
    color: "#ff9ca8",
  },
  link: {
    color: "#ffd369",
    textDecoration: "underline",
    cursor: "pointer",
  },
};

const formatDate = (date) => {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
};

const initialForm = {
  amount: "",
  customer_name: "",
  customer_email: "",
  customer_mobile: "",
  userId: "",
  p_info: "Wallet deposit",
};

export default function AddCashPage() {
  const [form, setForm] = useState(initialForm);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [paymentUrl, setPaymentUrl] = useState("");
  const [clientTxnId, setClientTxnId] = useState("");
  const [statusText, setStatusText] = useState("");

  const updateField = (key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");
    setMessage("");
    setStatusText("");
    setPaymentUrl("");
    setClientTxnId("");

    if (!form.amount || Number(form.amount) <= 0) {
      setError("Enter a valid amount greater than zero.");
      return;
    }
    if (!form.customer_name.trim()) {
      setError("Enter your name.");
      return;
    }
    if (!form.customer_email.trim()) {
      setError("Enter your email.");
      return;
    }
    if (!form.customer_mobile.trim()) {
      setError("Enter your mobile number.");
      return;
    }
    if (!form.userId.trim()) {
      setError("Enter your user ID.");
      return;
    }

    setLoading(true);

    try {
      const response = await fetch("/api/payment/create-order", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(form),
      });

      const data = await response.json();
      if (!response.ok || data.success === false) {
        const messageText = data.error || data.message || "Unable to create payment order.";
        setError(messageText);
        return;
      }

      const { payment_url, client_txn_id } = data.data ?? data;
      if (!payment_url) {
        setError("Payment gateway did not return a payment URL.");
        return;
      }

      setPaymentUrl(payment_url);
      setClientTxnId(client_txn_id || "");
      setMessage("Payment order created. Redirecting to gateway...");
      window.location.href = payment_url;
    } catch (err) {
      setError("Failed to create payment order. Try again.");
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleCheckStatus = async () => {
    setError("");
    setMessage("");
    setStatusText("");
    if (!clientTxnId) {
      setError("No payment transaction ID available to check.");
      return;
    }

    setLoading(true);
    try {
      const txn_date = formatDate(new Date());
      const response = await fetch("/api/payment/check-status", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ client_txn_id: clientTxnId, txn_date }),
      });
      const data = await response.json();
      if (!response.ok || data.success === false) {
        setError(data.error || "Failed to check payment status.");
        return;
      }
      const reconciliation = data.data?.reconciliation ?? data.reconciliation;
      const paymentStatus = data.data?.paymentStatus ?? data.paymentStatus;
      setMessage("Payment status fetched successfully.");
      setStatusText(`Gateway status: ${reconciliation || "unknown"}. Payment status: ${paymentStatus || "unknown"}.`);
    } catch (err) {
      setError("Could not load status. Try again later.");
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main style={styles.page}>
      <section style={styles.card}>
        <header style={styles.header}>
          <h1 style={styles.title}>Pay with UPI Gateway</h1>
          <p style={styles.subtitle}>
            Use the payment gateway for instant wallet top-up. No manual screenshot or reference upload required.
          </p>
        </header>

        <form style={styles.formGroup} onSubmit={handleSubmit}>
          <label style={styles.label}>
            Amount (₹)
            <input
              style={styles.input}
              type="number"
              min="1"
              step="1"
              name="amount"
              value={form.amount}
              onChange={(event) => updateField("amount", event.target.value)}
              placeholder="Enter deposit amount"
            />
          </label>

          <label style={styles.label}>
            Your Name
            <input
              style={styles.input}
              type="text"
              name="customer_name"
              value={form.customer_name}
              onChange={(event) => updateField("customer_name", event.target.value)}
              placeholder="Full name"
            />
          </label>

          <label style={styles.label}>
            Email Address
            <input
              style={styles.input}
              type="email"
              name="customer_email"
              value={form.customer_email}
              onChange={(event) => updateField("customer_email", event.target.value)}
              placeholder="name@example.com"
            />
          </label>

          <label style={styles.label}>
            Mobile Number
            <input
              style={styles.input}
              type="tel"
              name="customer_mobile"
              value={form.customer_mobile}
              onChange={(event) => updateField("customer_mobile", event.target.value)}
              placeholder="Enter mobile number"
            />
          </label>

          <label style={styles.label}>
            User ID
            <input
              style={styles.input}
              type="text"
              name="userId"
              value={form.userId}
              onChange={(event) => updateField("userId", event.target.value)}
              placeholder="MongoDB user ObjectId"
            />
          </label>

          <label style={styles.label}>
            Purpose
            <input
              style={styles.input}
              type="text"
              name="p_info"
              value={form.p_info}
              onChange={(event) => updateField("p_info", event.target.value)}
              placeholder="Deposit for wallet top-up"
            />
          </label>

          <button type="submit" style={styles.button} disabled={loading}>
            {loading ? "Creating payment order..." : "Proceed to Gateway"}
          </button>
        </form>

        <div style={styles.infoBox}>
          <p>
            Gateway payment is the correct flow: you will be redirected to the UPI checkout page. After payment, use the same page to verify your status.
          </p>
          {clientTxnId ? (
            <p>
              <strong>Transaction ID:</strong> {clientTxnId}
            </p>
          ) : null}
          {paymentUrl ? (
            <p>
              <strong>Payment URL:</strong>{" "}
              <a href={paymentUrl} style={styles.link} target="_blank" rel="noreferrer">
                Open gateway manually
              </a>
            </p>
          ) : null}
          {message ? <p style={styles.success}>{message}</p> : null}
          {statusText ? <p style={styles.success}>{statusText}</p> : null}
          {error ? <p style={styles.error}>{error}</p> : null}
        </div>

        {clientTxnId ? (
          <button
            type="button"
            style={{ ...styles.button, ...styles.buttonSecondary, marginTop: "1rem" }}
            onClick={handleCheckStatus}
            disabled={loading}
          >
            Check payment status
          </button>
        ) : null}
      </section>
    </main>
  );
}
