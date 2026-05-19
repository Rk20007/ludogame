import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI;

/** @type {{ conn: typeof mongoose | null; promise: Promise<typeof mongoose> | null }} */
let cached = globalThis._mongoose;

if (!cached) {
  cached = globalThis._mongoose = { conn: null, promise: null };
}

/**
 * Cached connection for Next.js (App Router / serverless).
 * Reuses a single connection across hot reloads and isolates from accidental buffer growth.
 */
export async function connectDB() {
  if (!MONGODB_URI) {
    throw new Error("MONGODB_URI is not defined in environment variables.");
  }

  if (cached.conn) {
    return cached.conn;
  }

  if (!cached.promise) {
    cached.promise = mongoose
      .connect(MONGODB_URI, {
        autoIndex: process.env.NODE_ENV !== "production",
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 10_000,
      })
      .then((m) => m);
  }

  cached.conn = await cached.promise;
  return cached.conn;
}
